/**
 * TitanioPOS - Impresión en red entre cajas (sección printShare del settings).
 *
 * Modo 'share' (caja anfitriona): mini servidor HTTP en 0.0.0.0:sharePort.
 *   GET  /health      -> identidad + config de ticket/etiquetas + parámetros fiscales
 *   POST /print       -> { content, options } imprime en la térmica local
 *   POST /print-label -> { content } imprime el HTML en la etiquetera local
 *
 * Modo 'receive' (caja cliente): printer-handlers reenvía los tickets aquí
 * (sendRemotePrint) y fiscal-handlers pide la URL/params remotos
 * (getRemoteFiscalTarget / getRemoteFiscalParams). Las peticiones fiscales van
 * DIRECTO al servidor Flask de la anfitriona (ya escucha en 0.0.0.0); el
 * servidor de este módulo solo comparte la térmica y publica los parámetros.
 *
 * La anfitriona se alcanza por lo que configuró el usuario (`hostIp`: nombre
 * Windows o IP) y, si eso no responde, por sus alias aprendidos (`hostLastIp`,
 * `hostName`, `hostIps`) — ver hostCandidates/requestHost.
 *
 * Cada impresora tiene SU anfitriona (`hosts.ticket` / `hosts.fiscal` /
 * `hosts.label`): la tickera puede venir de una caja y la fiscal de otra. Por
 * eso todo lo que se recuerda de una anfitriona (dirección que respondió,
 * fallos, snapshots) va por su clave nombre|puerto, no en un único global.
 */

const { ipcMain } = require('electron');
const http = require('http');
const os = require('os');
const {
  readSettings,
  writeSettings,
  normalizePrintShare,
  normalizePrintShareHost,
  PRINT_SHARE_KINDS,
} = require('./titaniopos-settings-file');

const MAX_PRINT_BODY = 2 * 1024 * 1024;
const REMOTE_PRINT_TIMEOUT_MS = 8000;
// Cortocircuito tras un fallo de RED con la anfitriona: los tickets siguientes
// fallan al instante durante esta ventana en vez de colgar la caja 8s cada vez.
const REMOTE_PRINT_COOLDOWN_MS = 10000;
const HEALTH_TIMEOUT_MS = 4000;
// Conectar con UNA dirección de la anfitriona no puede comerse todo el tiempo
// del ticket: si en 3s no hay TCP, se prueba la siguiente (IP conocida, nombre…).
const CONNECT_TIMEOUT_MS = 3000;
// Errores de RED/DNS con los que vale probar otra dirección de la anfitriona.
// Todo lo demás (respondió y falló, se cortó a medias) NO se reintenta en un
// POST de impresión: podría haber llegado y saldría un ticket doble.
const UNREACHABLE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA',
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ETIMEDOUT',
  'EADDRNOTAVAIL', 'ECONNTIMEOUT',
]);
const HOST_FISCAL_TTL_MS = 60000;
// Caché negativa del /health fiscal: con la anfitriona caída no se reintenta
// en cada poll (cada 1.5s); se usa el último snapshot conocido.
const HOST_FISCAL_FAIL_COOLDOWN_MS = 30000;

// Claves fiscales que se heredan de la caja anfitriona al imprimir remoto:
// son propias de SU máquina/formato. storeCode y cashRegisterNumber NUNCA:
// cada caja factura con su propio número (dedupe i05Caja del fiscal-server).
const HOST_FISCAL_KEYS = [
  'fiscalMode', 'printBarcode', 'barcodeRaw', 'itemDescLen',
  'discountMode', 'descLeaders', 'percibidoChar', 'machineSerial',
];

let shareServer = null;
let shareServerPort = null;
let shareServerError = null;
// Snapshot en memoria de los params fiscales de la anfitriona de la FISCAL.
// `key` = de qué anfitriona es: si la fiscal pasa a otra caja, no sirve.
let hostFiscalMem = { key: null, params: null, at: 0 };
// Último /health fallido por anfitriona (caché negativa).
const healthFailAt = new Map();
let lastRemotePrintFailAt = 0;
// Snapshot de la impresora de etiquetas de la anfitriona de las ETIQUETAS.
let hostLabelMem = { key: null, params: null, at: 0 };
let lastRemoteLabelFailAt = 0;
// Dirección (nombre o IP) que respondió la última vez en esta sesión, por
// anfitriona: se prueba primero. Se invalida al guardar otra config.
const sessionGoodHost = new Map();
// /health del último diagnóstico por anfitriona: si enseguida se le apunta la
// fiscal o las etiquetas, su snapshot arranca con lo que ya respondió.
const checkedHealth = new Map(); // key -> { data, at }
const CHECKED_HEALTH_TTL_MS = 10 * 60 * 1000;
// `app` de Electron, para persistir lo aprendido de la anfitriona desde los
// caminos que no lo reciben (printer-handlers llama sendRemotePrint sin app).
let appRef = null;

const USE_REMOTE_FLAG = { ticket: 'useRemoteTicket', fiscal: 'useRemoteFiscal', label: 'useRemoteLabel' };

const loadPrintShareConfig = (app) => normalizePrintShare(readSettings(app).printShare);

const hostKey = (host) => (host ? `${String(host.hostIp || '').trim().toLowerCase()}|${host.hostPort}` : '');

const sameHost = (a, b) => Boolean(a && b) && hostKey(a) === hostKey(b);

/**
 * Anfitriona que manda la vista para una impresora, con lo ya aprendido de esa
 * MISMA caja (nombre, última IP, IPs) si alguna impresora ya la usaba. Si es
 * otra caja, lo aprendido de la anterior no vale y arranca limpia.
 */
function hostFromView(raw, currentHosts) {
  const host = normalizePrintShareHost(raw);
  if (!host) return null;
  const known = PRINT_SHARE_KINDS.map((kind) => currentHosts[kind]).find((h) => sameHost(h, host));
  if (!known) return { ...host, hostName: '', hostLastIp: '' };
  return {
    ...host,
    hostName: known.hostName,
    hostLastIp: known.hostLastIp,
    hostIps: host.hostIps.length ? host.hostIps : [...known.hostIps],
  };
}

/**
 * Anfitriona de cada impresora tras un guardado.
 *
 * Vista multi-anfitriona: manda `hosts` con las impresoras que cambia (null =
 * volver a la local); las que no nombra quedan como estaban.
 *
 * Vista de UNA anfitriona (hostIp + useRemote*): lo que enciende apunta a esa
 * anfitriona y lo que apaga vuelve a local. Lo que ya venía de otra caja solo
 * se mueve si la vista CAMBIÓ de anfitriona — un guardado sin cambios no debe
 * deshacer un reparto entre cajas que esa vista no sabe mostrar.
 */
function resolveHostsForSave(current, p) {
  const hosts = { ...current.hosts };
  if (p.hosts && typeof p.hosts === 'object') {
    for (const kind of PRINT_SHARE_KINDS) {
      if (kind in p.hosts) hosts[kind] = hostFromView(p.hosts[kind], current.hosts);
    }
    return hosts;
  }

  const typed = typeof p.hostIp === 'string' ? p.hostIp.trim() : null;
  const single = {
    hostIp: typed !== null ? typed : current.hostIp,
    hostPort: p.hostPort !== undefined ? p.hostPort : current.hostPort,
    hostIps: Array.isArray(p.hostIps) ? p.hostIps : [],
  };
  const hostChanged = typed !== null && hostKey(normalizePrintShareHost(single)) !== hostKey(current);
  if (!hostChanged && !Array.isArray(p.hostIps)) single.hostIps = current.hostIps;
  for (const kind of PRINT_SHARE_KINDS) {
    const flag = p[USE_REMOTE_FLAG[kind]];
    if (flag === false) {
      hosts[kind] = null;
      continue;
    }
    const turnsOn = flag === true && !hosts[kind];
    const follows = hostChanged && (flag === true || Boolean(hosts[kind]));
    if (turnsOn || follows) hosts[kind] = hostFromView(single, current.hosts);
  }
  return hosts;
}

/** Snapshot (fiscal / etiquetas) con el que arranca una anfitriona recién apuntada. */
function seedSnapshot(host, pick) {
  const checked = checkedHealth.get(hostKey(host));
  if (!checked || Date.now() - checked.at > CHECKED_HEALTH_TTL_MS) return null;
  return pick(checked.data);
}

const savePrintShareConfig = (app, partial) => {
  const s = readSettings(app);
  // Base SIEMPRE en formato flex: así un partial legado se aplica sobre el
  // comportamiento efectivo actual, no sobre el crudo viejo.
  const current = normalizePrintShare(s.printShare);
  const p = { ...(partial && typeof partial === 'object' ? partial : {}) };

  // Partial de una vista vieja (manda mode sin shareEnabled): traducirlo al
  // modelo flex con la semántica excluyente que esa vista espera.
  if (typeof p.shareEnabled !== 'boolean' && typeof p.mode === 'string') {
    if (p.mode === 'share') {
      p.shareEnabled = true;
    } else if (p.mode === 'receive') {
      p.shareEnabled = false;
      p.useRemoteTicket = p.useRemoteTicket !== false;
      p.useRemoteFiscal = p.useRemoteFiscal === true;
      if (typeof p.useRemoteLabel !== 'boolean') p.useRemoteLabel = true;
    } else {
      p.shareEnabled = false;
      p.useRemoteTicket = false;
      p.useRemoteFiscal = false;
      p.useRemoteLabel = false;
    }
  }

  const hosts = resolveHostsForSave(current, p);

  // Otra anfitriona: lo aprendido de la anterior (nombre, IPs, última IP que
  // respondió) ya no vale. Las IPs que mande la vista (mapa) sí se conservan.
  // Solo pesa cuando no se consume nada: si no, el resumen sale de `hosts`.
  if (typeof p.hostIp === 'string' && p.hostIp.trim() !== current.hostIp) {
    p.hostName = '';
    p.hostLastIp = '';
    if (!Array.isArray(p.hostIps)) p.hostIps = [];
  }

  // La fiscal o las etiquetas pasan a otra caja: el snapshot de la anterior
  // (formato fiscal, puerto, tamaño del sticker) no es el de la nueva.
  const snapshots = {};
  if (!sameHost(hosts.fiscal, current.hosts.fiscal)) {
    snapshots.hostFiscal = hosts.fiscal ? seedSnapshot(hosts.fiscal, (d) => pickHostFiscalParams(d.fiscal)) : null;
  }
  if (!sameHost(hosts.label, current.hosts.label)) {
    snapshots.hostLabel = hosts.label ? seedSnapshot(hosts.label, (d) => pickHostLabelParams(healthLabelOf(d))) : null;
  }

  s.printShare = normalizePrintShare({
    ...current,
    ...p,
    ...snapshots,
    hosts,
    lastUpdated: new Date().toISOString(),
  });
  writeSettings(app, s);
  return s.printShare;
};

function getLanIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      // 169.254.* = link-local (APIPA), no sirve para configurar otra caja.
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
        out.push(net.address);
      }
    }
  }
  return out;
}

function parseFiscalPort(serverUrl) {
  try {
    const p = parseInt(new URL(serverUrl || 'http://localhost:3000').port, 10);
    return Number.isFinite(p) && p > 0 ? p : 3000;
  } catch {
    return 3000;
  }
}

function pickHostFiscalParams(fiscal) {
  if (!fiscal || typeof fiscal !== 'object') return null;
  const out = {};
  for (const key of HOST_FISCAL_KEYS) {
    if (fiscal[key] !== undefined) out[key] = fiscal[key];
  }
  if (fiscal.port !== undefined) out.port = fiscal.port;
  if (fiscal.enabled !== undefined) out.enabled = fiscal.enabled;
  return out;
}

function pickHostLabelParams(label) {
  if (!label || typeof label !== 'object') return null;
  return {
    configured: label.configured === true,
    widthMm: label.widthMm,
    heightMm: label.heightMm,
    layout: label.layout,
  };
}

function buildHealthPayload(app) {
  const settings = readSettings(app);
  const thermal = settings.thermalPrinter || {};
  const label = settings.labelPrinter || {};
  const fiscal = settings.fiscal || {};
  const share = normalizePrintShare(settings.printShare);
  return {
    ok: true,
    app: 'titaniopos-print-share',
    version: app.getVersion(),
    hostname: os.hostname(),
    // IPs de LAN: el cliente las guarda como respaldo por si el nombre deja
    // de resolver (y la IP cambia por DHCP, de ahí que sea una lista viva).
    ips: getLanIps(),
    // 'share' mientras el servidor esté expuesto: lo exige el checkHost de los
    // clientes viejos. El detalle por impresora va en `shared`.
    mode: share.mode,
    shared: {
      ticket: share.shareTicket,
      fiscal: share.shareFiscal,
      label: share.shareLabel,
    },
    ticket: {
      configured: Boolean(thermal.printerName),
      printerName: thermal.printerName || '',
      paperWidth: thermal.paperWidth || '80mm',
    },
    // La caja cliente renderiza el sticker con las dimensiones/estilo de ESTA
    // impresora antes de mandarlo a /print-label.
    label: {
      configured: Boolean(label.printerName),
      printerName: label.printerName || '',
      widthMm: label.widthMm,
      heightMm: label.heightMm,
      layout: label.layout,
    },
    fiscal: {
      enabled: fiscal.enabled === true,
      serverEnabled: fiscal.serverEnabled === true,
      port: parseFiscalPort(fiscal.serverUrl),
      fiscalMode: fiscal.fiscalMode === true,
      printBarcode: fiscal.printBarcode,
      barcodeRaw: fiscal.barcodeRaw,
      itemDescLen: fiscal.itemDescLen,
      discountMode: fiscal.discountMode,
      descLeaders: fiscal.descLeaders,
      percibidoChar: fiscal.percibidoChar,
      machineSerial: fiscal.machineSerial,
    },
  };
}

function httpJsonRequest({ hostname, port, path, method, body, timeoutMs, connectTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    const req = http.request(
      {
        hostname,
        port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        // IP real que atendió (puede venir como ::ffff:192.168.1.5): con ella
        // se aprende la dirección de la anfitriona aunque se configuró por nombre.
        const remoteAddress = res.socket && res.socket.remoteAddress ? String(res.socket.remoteAddress) : '';
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw }; }
          resolve({ statusCode: res.statusCode || 500, data, remoteAddress });
        });
      }
    );
    if (connectTimeoutMs) {
      // Presupuesto SOLO para resolver el nombre y abrir el TCP; la respuesta
      // (imprimir tarda) sigue bajo timeoutMs. Sin esto, un nombre que no
      // resuelve o una IP muerta se comían el timeout completo por dirección.
      connectTimer = setTimeout(() => {
        const err = new Error(`Sin conexión en ${Math.round(connectTimeoutMs / 1000)}s`);
        err.code = 'ECONNTIMEOUT';
        req.destroy(err);
      }, connectTimeoutMs);
      req.on('socket', (socket) => {
        // Socket reutilizado (keep-alive) ya está conectado.
        if (socket.connecting === false) clearConnectTimer();
        else socket.once('connect', clearConnectTimer);
      });
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', (err) => {
      clearConnectTimer();
      reject(err);
    });
    req.on('close', clearConnectTimer);
    if (payload) req.write(payload);
    req.end();
  });
}

// ==================== ANFITRIONA: nombre + IPs de respaldo ====================

function isUnreachableError(e) {
  return Boolean(e && UNREACHABLE_CODES.has(e.code));
}

/** '::ffff:192.168.1.5' -> '192.168.1.5'; '' si no es una IPv4. */
function cleanIp(addr) {
  const s = String(addr || '').replace(/^::ffff:/i, '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? s : '';
}

/**
 * Direcciones por las que se intenta llegar a la anfitriona, en orden: la que
 * respondió en esta sesión, lo que configuró el usuario (nombre o IP), la
 * última IP que respondió, el nombre que ella reportó y sus IPs de LAN.
 *
 * Antes solo se probaba `hostIp`: si el nombre no resolvía (perfil de red
 * "Público", otra subred, equipo renombrado sin reiniciar) la caja se quedaba
 * sin imprimir hasta que alguien escribiera la IP a mano — y al hacerlo perdía
 * el nombre estable, que es el que sobrevive al DHCP.
 */
function hostCandidates(cfg) {
  const out = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (!s || out.some((x) => x.toLowerCase() === s.toLowerCase())) return;
    out.push(s);
  };
  push(sessionGoodHost.get(hostKey(cfg)));
  push(cfg.hostIp);
  push(cfg.hostLastIp);
  push(cfg.hostName);
  for (const ip of cfg.hostIps || []) push(ip);
  return out;
}

/** Dirección con más chance de responder ahora mismo (para la URL del fiscal). */
function preferredHost(cfg) {
  return sessionGoodHost.get(hostKey(cfg)) || cfg.hostLastIp || cfg.hostIp;
}

/**
 * Modifica printShare en disco (`mutate` recibe la config normalizada y la
 * altera en sitio); solo escribe si cambió algo.
 */
function patchPrintShare(mutate) {
  if (!appRef) return;
  try {
    const s = readSettings(appRef);
    const current = normalizePrintShare(s.printShare);
    const draft = normalizePrintShare(s.printShare);
    mutate(draft);
    const next = normalizePrintShare(draft);
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    s.printShare = next;
    writeSettings(appRef, s);
  } catch (e) {
    console.warn('[PRINT-SHARE] No se pudo persistir lo aprendido de la anfitriona:', e.message);
  }
}

/** Aplica lo aprendido de una anfitriona a TODAS las impresoras que la usan. */
function patchHostLearned(host, learned) {
  patchPrintShare((draft) => {
    let inUse = false;
    for (const kind of PRINT_SHARE_KINDS) {
      if (!draft.hosts[kind]) continue;
      inUse = true;
      if (sameHost(draft.hosts[kind], host)) Object.assign(draft.hosts[kind], learned);
    }
    // Sin nada en uso, la anfitriona guardada vive solo en la raíz.
    if (!inUse && sameHost(draft, host)) Object.assign(draft, learned);
  });
}

function rememberGoodHost(cfg, host, remoteAddress, persist) {
  sessionGoodHost.set(hostKey(cfg), host);
  if (!persist) return;
  const ip = cleanIp(remoteAddress);
  if (ip && ip !== cfg.hostLastIp) patchHostLearned(cfg, { hostLastIp: ip });
}

/** Nombre e IPs de LAN que la anfitriona dice de sí misma en /health. */
function captureHostIdentity(cfg, data, persist) {
  if (!persist || !data) return;
  const patch = {};
  const name = String(data.hostname || '').trim();
  if (name && name !== cfg.hostName) patch.hostName = name;
  if (Array.isArray(data.ips)) {
    const ips = data.ips.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
    if (ips.length && JSON.stringify(ips) !== JSON.stringify(cfg.hostIps || [])) patch.hostIps = ips;
  }
  if (Object.keys(patch).length) patchHostLearned(cfg, patch);
}

/**
 * Petición a la anfitriona probando sus direcciones en orden. `idempotent`
 * (GET /health) reintenta con la siguiente ante cualquier error; un POST de
 * impresión solo si la dirección era inalcanzable (no llegó nada allá).
 * `persist`: guardar lo aprendido — solo cuando cfg es la anfitriona
 * configurada, no un diagnóstico de otra caja.
 */
async function requestHost(cfg, { path, method, body, timeoutMs, idempotent = false, persist = true }) {
  const list = hostCandidates(cfg);
  if (!list.length) {
    const err = new Error('Sin caja anfitriona configurada');
    err.code = 'ENOHOST';
    throw err;
  }
  let lastErr = null;
  const tried = [];
  for (const host of list) {
    tried.push(host);
    try {
      const res = await httpJsonRequest({
        hostname: host, port: cfg.hostPort, path, method, body, timeoutMs, connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
      rememberGoodHost(cfg, host, res.remoteAddress, persist);
      return { ...res, via: host };
    } catch (e) {
      lastErr = e;
      const retry = idempotent || isUnreachableError(e);
      if (retry && tried.length < list.length) {
        console.warn(`[PRINT-SHARE] ${host}:${cfg.hostPort} no responde (${e.code || e.message}); probando la siguiente dirección`);
        continue;
      }
      break;
    }
  }
  const err = lastErr || new Error('Sin respuesta');
  err.tried = tried;
  throw err;
}

function describeTried(target, e) {
  const tried = Array.isArray(e && e.tried) ? e.tried : [];
  const extra = tried.length > 1 ? `; probadas: ${tried.join(', ')}` : '';
  return `${target.hostIp}:${target.hostPort}${extra}`;
}

// ==================== SERVIDOR (modo 'share') ====================

function startShareServer(app, port) {
  return new Promise((resolve) => {
    if (shareServer && shareServerPort === port) {
      resolve({ success: true, port });
      return;
    }
    const begin = () => {
      const server = http.createServer((req, res) => {
        // Sin estos handlers, un cliente que corta la conexión a mitad de un
        // POST emite 'error' sin listener y TUMBA el proceso main.
        req.on('error', (e) => console.warn('[PRINT-SHARE] request error:', e.message));
        res.on('error', (e) => console.warn('[PRINT-SHARE] response error:', e.message));
        const respond = (status, obj) => {
          try {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(obj));
          } catch (e) {
            console.warn('[PRINT-SHARE] respond error:', e.message);
          }
        };
        if (req.method === 'GET' && req.url === '/health') {
          try {
            respond(200, buildHealthPayload(app));
          } catch (e) {
            respond(500, { ok: false, error: e.message });
          }
          return;
        }
        if (req.method === 'POST' && (req.url === '/print' || req.url === '/print-label')) {
          const isLabel = req.url === '/print-label';
          let raw = '';
          let overflow = false;
          req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > MAX_PRINT_BODY) {
              overflow = true;
              req.destroy();
            }
          });
          req.on('end', async () => {
            if (overflow) return;
            try {
              const body = JSON.parse(raw || '{}');
              if (typeof body.content !== 'string' || !body.content) {
                respond(400, { success: false, error: 'Falta content' });
                return;
              }
              // Respeta lo que ESTA caja decidió compartir (modelo flex).
              const shareCfg = loadPrintShareConfig(app);
              if (isLabel ? !shareCfg.shareLabel : !shareCfg.shareTicket) {
                respond(403, {
                  success: false,
                  error: isLabel
                    ? 'La caja anfitriona no comparte su impresora de etiquetas.'
                    : 'La caja anfitriona no comparte su impresora de tickets.',
                });
                return;
              }
              let result;
              if (isLabel) {
                // Etiqueta: HTML renderizado por el cliente con las dims de ESTA
                // impresora (las publica /health). Va por el método nativo con
                // tamaño de página exacto = sticker, igual que la impresión local.
                const labelCfg = readSettings(app).labelPrinter || {};
                if (!labelCfg.printerName) {
                  respond(500, { success: false, error: 'La caja anfitriona no tiene impresora de etiquetas configurada.' });
                  return;
                }
                const printerMethods = require('./printer-methods');
                result = await printerMethods.printWithNativeAPI(
                  app,
                  labelCfg.printerName,
                  body.content,
                  `${labelCfg.widthMm}mm`,
                  { widthMm: labelCfg.widthMm, heightMm: labelCfg.heightMm }
                );
              } else {
                // Lazy require: printer-handlers también requiere este módulo.
                const { printWithConfiguredPrinter } = require('./printer-handlers');
                result = await printWithConfiguredPrinter(app, body.content);
              }
              console.log(`🖨️ [PRINT-SHARE] Job remoto${isLabel ? ' (etiqueta)' : ''} de`, req.socket.remoteAddress, '->', result.success ? 'OK' : result.error);
              respond(result.success ? 200 : 500, result);
            } catch (e) {
              respond(500, { success: false, error: e.message });
            }
          });
          return;
        }
        respond(404, { success: false, error: 'Not found' });
      });
      server.on('error', (err) => {
        console.error('❌ [PRINT-SHARE] Server error:', err.message);
        shareServer = null;
        shareServerPort = null;
        shareServerError = err.message;
        resolve({ success: false, error: err.message });
      });
      server.listen(port, '0.0.0.0', () => {
        shareServer = server;
        shareServerPort = port;
        shareServerError = null;
        console.log(`✅ [PRINT-SHARE] Compartiendo impresoras en 0.0.0.0:${port}`);
        resolve({ success: true, port });
      });
    };
    if (shareServer) {
      stopShareServer().then(begin);
    } else {
      begin();
    }
  });
}

function stopShareServer() {
  return new Promise((resolve) => {
    if (!shareServer) {
      resolve();
      return;
    }
    const server = shareServer;
    shareServer = null;
    shareServerPort = null;
    try {
      server.close(() => resolve());
      // No dejar el close colgado por keep-alives abiertos.
      setTimeout(resolve, 1500);
    } catch {
      resolve();
    }
  });
}

async function applyServerState(app) {
  const cfg = loadPrintShareConfig(app);
  if (cfg.shareEnabled) {
    if (shareServer && shareServerPort !== cfg.sharePort) await stopShareServer();
    if (!shareServer) return startShareServer(app, cfg.sharePort);
    return { success: true, port: shareServerPort };
  }
  await stopShareServer();
  shareServerError = null;
  return { success: true };
}

function getShareStatus(app) {
  const cfg = loadPrintShareConfig(app);
  return {
    mode: cfg.mode,
    running: Boolean(shareServer),
    port: shareServerPort || cfg.sharePort,
    // El nombre del equipo es el identificador ESTABLE para configurar en las
    // otras cajas (la IP suele ser DHCP y puede cambiar).
    hostname: os.hostname(),
    ips: getLanIps(),
    error: shareServerError,
  };
}

// ==================== NOMBRE DEL EQUIPO (Windows) ====================

// Reglas NetBIOS: 1-15 caracteres, letras/números/guiones, empieza por letra,
// no termina en guion. Validado ANTES de interpolar en PowerShell (sin comillas
// posibles, no hay inyección).
const COMPUTER_NAME_RE = /^[A-Za-z][A-Za-z0-9-]{0,14}$/;

/**
 * Nombre pendiente de reinicio: Rename-Computer escribe ComputerName en el
 * registro pero ActiveComputerName (= os.hostname) cambia recién al reiniciar
 * Windows. Devuelve el nombre nuevo si difiere del activo, o null.
 */
function getPendingComputerRename() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const { execFile } = require('child_process');
    execFile(
      'reg',
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\ComputerName\\ComputerName', '/v', 'ComputerName'],
      { windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = /ComputerName\s+REG_SZ\s+(\S+)/i.exec(stdout || '');
        const pending = m ? m[1] : null;
        if (pending && pending.toUpperCase() !== String(os.hostname()).toUpperCase()) {
          resolve(pending);
        } else {
          resolve(null);
        }
      }
    );
  });
}

async function shareStatusWithRename(app) {
  const status = getShareStatus(app);
  status.pendingHostname = await getPendingComputerRename();
  return status;
}

/**
 * Abre el firewall de Windows para la impresión en red (elevado, un solo UAC).
 * Por qué: el puerto de tickets lo atiende Electron (normalmente ya permitido),
 * pero el servidor fiscal es OTRO programa (python embebido) y Windows lo
 * bloquea desde la LAN aunque localhost funcione; si el usuario canceló el
 * aviso de Windows quedó una regla de BLOQUEO por programa que gana sobre las
 * reglas de puerto — por eso también se borran las reglas del python y se crea
 * un allow por programa.
 */
function allowFirewall(app, sharePort, fiscalPort) {
  return new Promise((resolve) => {
    const fs = require('fs');
    const path = require('path');
    const { execFile } = require('child_process');
    let pyPath = null;
    try {
      const { getEmbeddedPython } = require('./fiscal-server-manager');
      pyPath = getEmbeddedPython();
    } catch { /* opcional */ }

    const lines = [
      '@echo off',
      'netsh advfirewall firewall delete rule name="TitanioPOS impresion en red (tickets)" >nul 2>&1',
      `netsh advfirewall firewall add rule name="TitanioPOS impresion en red (tickets)" dir=in action=allow protocol=TCP localport=${sharePort}`,
      'netsh advfirewall firewall delete rule name="TitanioPOS fiscal en red (puerto)" >nul 2>&1',
      `netsh advfirewall firewall add rule name="TitanioPOS fiscal en red (puerto)" dir=in action=allow protocol=TCP localport=${fiscalPort}`,
    ];
    if (pyPath && fs.existsSync(pyPath)) {
      lines.push(`netsh advfirewall firewall delete rule name=all program="${pyPath}" >nul 2>&1`);
      lines.push(`netsh advfirewall firewall add rule name="TitanioPOS fiscal server (python)" dir=in action=allow program="${pyPath}"`);
    }
    lines.push('exit /b 0');

    const bat = path.join(app.getPath('temp'), 'titaniopos-firewall.bat');
    try {
      fs.writeFileSync(bat, lines.join('\r\n'), 'utf-8');
    } catch (e) {
      resolve({ success: false, error: e.message });
      return;
    }

    const outer = `try { $p = Start-Process -Verb RunAs -Wait -PassThru -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c','"${bat.replace(/'/g, "''")}"'; exit $p.ExitCode } catch { exit 2 }`;
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer],
      { windowsHide: true, timeout: 180000 },
      (error) => {
        if (!error) return resolve({ success: true, pythonRule: Boolean(pyPath) });
        if (error.code === 2) return resolve({ success: false, error: 'Permiso de administrador cancelado.' });
        resolve({ success: false, error: 'No se pudieron crear las reglas del firewall.' });
      }
    );
  });
}

function renameComputer(newName) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    // PowerShell elevado (UAC). El exit code del proceso elevado se propaga:
    // 0 = renombrado, 1 = Rename-Computer falló, 2 = UAC cancelado.
    const inner = `try { Rename-Computer -NewName ''${newName}'' -Force -ErrorAction Stop; exit 0 } catch { exit 1 }`;
    const outer = `try { $p = Start-Process -Verb RunAs -Wait -PassThru -WindowStyle Hidden -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command','${inner}'; exit $p.ExitCode } catch { exit 2 }`;
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outer],
      { windowsHide: true, timeout: 180000 },
      (error) => {
        if (!error) return resolve({ success: true });
        if (error.code === 2) return resolve({ success: false, error: 'Permiso de administrador cancelado.' });
        resolve({ success: false, error: 'Windows rechazó el cambio de nombre (¿nombre en uso en la red?).' });
      }
    );
  });
}

// ==================== CLIENTE (modo 'receive') ====================

/**
 * {hostIp, hostPort} si esta caja manda los TICKETS a otra; null si no.
 * `hosts` ya viene resuelto de normalizePrintShare (una caja puede compartir
 * y consumir a la vez, y cada impresora tiene su propia anfitriona). `cfg` es
 * esa anfitriona con sus alias, para requestHost.
 */
function getRemoteTicketTarget(app) {
  const host = loadPrintShareConfig(app).hosts.ticket;
  return host ? { hostIp: host.hostIp, hostPort: host.hostPort, cfg: host } : null;
}

async function sendRemotePrint(target, content, options = {}) {
  if (Date.now() - lastRemotePrintFailAt < REMOTE_PRINT_COOLDOWN_MS) {
    return {
      success: false,
      remote: true,
      error: `La caja anfitriona (${target.hostIp}) no respondió hace un momento. Reintenta en unos segundos.`,
    };
  }
  const cfg = target.cfg || { hostIp: target.hostIp, hostPort: target.hostPort, hostIps: [] };
  try {
    const { statusCode, data } = await requestHost(cfg, {
      path: '/print',
      method: 'POST',
      body: { content, options },
      timeoutMs: REMOTE_PRINT_TIMEOUT_MS,
    });
    if (statusCode >= 200 && statusCode < 300 && data && data.success) {
      lastRemotePrintFailAt = 0;
      return { ...data, remote: true };
    }
    // La anfitriona respondió pero no pudo imprimir (impresora de allá): la red
    // está bien, no se activa el cortocircuito.
    const detail = (data && (data.error || data.message)) || `HTTP ${statusCode}`;
    return { success: false, remote: true, error: `La caja anfitriona no pudo imprimir: ${detail}` };
  } catch (e) {
    lastRemotePrintFailAt = Date.now();
    return {
      success: false,
      remote: true,
      error: `No se pudo imprimir en la caja anfitriona (${describeTried(target, e)}): ${e.message}`,
    };
  }
}

/** {hostIp, hostPort} si esta caja manda las ETIQUETAS a otra; null si no. */
function getRemoteLabelTarget(app) {
  const host = loadPrintShareConfig(app).hosts.label;
  return host ? { hostIp: host.hostIp, hostPort: host.hostPort, cfg: host } : null;
}

async function sendRemoteLabelPrint(target, content) {
  if (Date.now() - lastRemoteLabelFailAt < REMOTE_PRINT_COOLDOWN_MS) {
    return {
      success: false,
      remote: true,
      error: `La caja anfitriona (${target.hostIp}) no respondió hace un momento. Reintenta en unos segundos.`,
    };
  }
  const cfg = target.cfg || { hostIp: target.hostIp, hostPort: target.hostPort, hostIps: [] };
  try {
    const { statusCode, data } = await requestHost(cfg, {
      path: '/print-label',
      method: 'POST',
      body: { content },
      timeoutMs: REMOTE_PRINT_TIMEOUT_MS,
    });
    if (statusCode >= 200 && statusCode < 300 && data && data.success) {
      lastRemoteLabelFailAt = 0;
      return { ...data, remote: true };
    }
    // Respondió pero no imprimió (impresora/config de allá): la red está bien.
    const detail = (data && (data.error || data.message)) || `HTTP ${statusCode}`;
    return { success: false, remote: true, error: `La caja anfitriona no pudo imprimir la etiqueta: ${detail}` };
  } catch (e) {
    lastRemoteLabelFailAt = Date.now();
    return {
      success: false,
      remote: true,
      error: `No se pudo imprimir en la caja anfitriona (${describeTried(target, e)}): ${e.message}`,
    };
  }
}

/** URL del servidor fiscal remoto si esta caja usa la fiscal de otra; null si no. */
function getRemoteFiscalTarget(app) {
  const cfg = loadPrintShareConfig(app);
  const fiscalHost = cfg.hosts.fiscal;
  if (!fiscalHost) return null;
  const mem = fiscalMemOf(fiscalHost);
  const port =
    (mem && mem.port) ||
    (cfg.hostFiscal && cfg.hostFiscal.port) ||
    3005;
  // La dirección que respondió (o la última IP conocida): el Flask de la
  // anfitriona vive en la misma máquina que su servidor de compartir.
  const host = preferredHost(fiscalHost);
  return { url: `http://${host}:${port}`, hostIp: host };
}

/** Snapshot en memoria, solo si es de ESTA anfitriona. */
const fiscalMemOf = (host) => (hostFiscalMem.key === hostKey(host) ? hostFiscalMem.params : null);
const labelMemOf = (host) => (hostLabelMem.key === hostKey(host) ? hostLabelMem.params : null);

function persistSnapshot(app, field, params) {
  try {
    const s = readSettings(app);
    const current = s.printShare && s.printShare[field];
    if (JSON.stringify(current) === JSON.stringify(params)) return;
    s.printShare = normalizePrintShare({ ...s.printShare, [field]: params });
    writeSettings(app, s);
  } catch (e) {
    console.warn(`[PRINT-SHARE] No se pudo persistir ${field}:`, e.message);
  }
}

/**
 * Etiquetas según el /health completo: si la anfitriona dejó de COMPARTIR su
 * etiquetera (shared.label false, modelo flex), para el cliente cuenta como no
 * disponible aunque esté configurada allá.
 */
function healthLabelOf(data) {
  if (!data) return null;
  if (data.shared && data.shared.label === false) {
    return { ...(data.label || {}), configured: false };
  }
  return data.label;
}

/**
 * Guarda lo que un /health dice de `host`, SOLO para las impresoras que esta
 * caja toma de esa anfitriona: el snapshot fiscal si de ahí sale la fiscal, el
 * de etiquetas si de ahí salen las etiquetas (memoria + settings).
 */
function captureHealth(app, host, data, at) {
  const cfg = loadPrintShareConfig(app);
  if (sameHost(cfg.hosts.fiscal, host) && data.fiscal) {
    const params = pickHostFiscalParams(data.fiscal);
    hostFiscalMem = { key: hostKey(host), params, at };
    persistSnapshot(app, 'hostFiscal', params);
  }
  if (sameHost(cfg.hosts.label, host)) {
    const params = pickHostLabelParams(healthLabelOf(data));
    if (params) {
      hostLabelMem = { key: hostKey(host), params, at };
      persistSnapshot(app, 'hostLabel', params);
    }
  }
}

/**
 * Parámetros de la impresora de etiquetas de la anfitriona (dims, layout).
 * Mismo contrato que getRemoteFiscalParams: caché de 60s por /health, caída al
 * último snapshot conocido, null si no aplica el modo remoto.
 */
async function getRemoteLabelParams(app, { refresh = false } = {}) {
  const cfg = loadPrintShareConfig(app);
  const host = cfg.hosts.label;
  if (!host) return null;
  const key = hostKey(host);
  const now = Date.now();
  if (!refresh && labelMemOf(host) && now - hostLabelMem.at < HOST_FISCAL_TTL_MS) {
    return hostLabelMem.params;
  }
  // Caché negativa por anfitriona (la comparte con la fiscal si salen de la
  // misma caja: es el mismo /health).
  if (now - (healthFailAt.get(key) || 0) < HOST_FISCAL_FAIL_COOLDOWN_MS) {
    return labelMemOf(host) || cfg.hostLabel || null;
  }
  try {
    const { statusCode, data } = await requestHost(host, {
      path: '/health',
      method: 'GET',
      timeoutMs: HEALTH_TIMEOUT_MS,
      idempotent: true,
    });
    if (statusCode === 200 && data) {
      captureHostIdentity(host, data, true);
      // Si la fiscal sale de esta misma caja, su snapshot se refresca de paso.
      captureHealth(app, host, data, now);
      healthFailAt.delete(key);
      return labelMemOf(host);
    }
    healthFailAt.set(key, now);
  } catch (e) {
    healthFailAt.set(key, now);
    console.warn('[PRINT-SHARE] /health de la anfitriona no responde:', e.message);
  }
  return labelMemOf(host) || cfg.hostLabel || null;
}

/**
 * Parámetros fiscales de la caja anfitriona (fiscalMode, barcode, formato…).
 * Refresca por /health con caché de 60s; si el host no responde cae al último
 * snapshot conocido (memoria -> settings). null si no aplica el modo remoto.
 */
async function getRemoteFiscalParams(app, { refresh = false } = {}) {
  const cfg = loadPrintShareConfig(app);
  const host = cfg.hosts.fiscal;
  if (!host) return null;
  const key = hostKey(host);
  const now = Date.now();
  if (!refresh && fiscalMemOf(host) && now - hostFiscalMem.at < HOST_FISCAL_TTL_MS) {
    return hostFiscalMem.params;
  }
  // Caché negativa: si la anfitriona acaba de fallar, no colgar cada llamada
  // fiscal 3s reintentando el /health — usar el último snapshot conocido.
  if (now - (healthFailAt.get(key) || 0) < HOST_FISCAL_FAIL_COOLDOWN_MS) {
    return fiscalMemOf(host) || cfg.hostFiscal || null;
  }
  try {
    const { statusCode, data } = await requestHost(host, {
      path: '/health',
      method: 'GET',
      timeoutMs: HEALTH_TIMEOUT_MS,
      idempotent: true,
    });
    if (statusCode === 200 && data && data.fiscal) {
      captureHostIdentity(host, data, true);
      captureHealth(app, host, data, now);
      healthFailAt.delete(key);
      return fiscalMemOf(host);
    }
    healthFailAt.set(key, now);
  } catch (e) {
    healthFailAt.set(key, now);
    console.warn('[PRINT-SHARE] /health de la anfitriona no responde:', e.message);
  }
  return fiscalMemOf(host) || cfg.hostFiscal || null;
}

async function checkHost(app, hostIp, hostPort, fallbackIps = []) {
  const ip = String(hostIp || '').trim();
  const port = parseInt(hostPort, 10) || 3020;
  if (!ip) return { success: false, error: 'Indica la IP o el nombre de la caja anfitriona' };
  const cfg = loadPrintShareConfig(app);
  const target = { hostIp: ip, hostPort: port };
  // ¿Se diagnostica una anfitriona YA configurada (la de alguna impresora, o
  // la última guardada)? Entonces valen sus alias aprendidos y lo que se
  // aprenda ahora se guarda.
  const saved = [...PRINT_SHARE_KINDS.map((kind) => cfg.hosts[kind]), cfg]
    .find((h) => h && h.hostIp && sameHost(h, target)) || null;
  const probe = {
    ...target,
    hostName: saved ? saved.hostName : '',
    hostLastIp: saved ? saved.hostLastIp : '',
    hostIps: [...(Array.isArray(fallbackIps) ? fallbackIps : []), ...(saved ? saved.hostIps : [])],
  };
  try {
    const { statusCode, data, via } = await requestHost(probe, {
      path: '/health', method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS, idempotent: true, persist: Boolean(saved),
    });
    if (statusCode !== 200 || !data || data.app !== 'titaniopos-print-share') {
      return { success: false, error: `Respondió algo que no es una caja compartiendo (HTTP ${statusCode})`, via };
    }
    if (data.mode !== 'share') {
      return { success: false, error: `La caja ${data.hostname} no está en modo compartir`, via };
    }
    // Probar también el servidor fiscal Flask de la anfitriona (puerto aparte),
    // por la misma dirección que acaba de responder.
    let fiscalReachable = false;
    if (data.fiscal && data.fiscal.enabled) {
      try {
        const fiscalProbe = await httpJsonRequest({
          hostname: via, port: data.fiscal.port, path: '/health', method: 'GET', timeoutMs: 3000, connectTimeoutMs: CONNECT_TIMEOUT_MS,
        });
        fiscalReachable = fiscalProbe.statusCode === 200;
      } catch { fiscalReachable = false; }
    }
    // Lo que respondió queda a mano por si enseguida se le apunta una
    // impresora (savePrintShareConfig arranca su snapshot con esto); y si
    // alguna ya sale de esta caja, se refrescan su snapshot y su nombre/IPs.
    const at = Date.now();
    checkedHealth.set(hostKey(target), { data, at });
    if (saved) {
      captureHealth(app, saved, data, at);
      captureHostIdentity(saved, data, true);
    }
    return { success: true, health: data, fiscalReachable, via };
  } catch (e) {
    const tried = Array.isArray(e.tried) && e.tried.length > 1 ? ` (probadas: ${e.tried.join(', ')})` : '';
    return { success: false, error: `Sin conexión con ${ip}:${port}${tried}: ${e.message}` };
  }
}

// ==================== IPC ====================

function registerPrintShareHandlers(app) {
  appRef = app;
  ipcMain.handle('print-share-config-get', async () => {
    try {
      return { success: true, config: loadPrintShareConfig(app), status: await shareStatusWithRename(app) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('print-share-config-save', async (event, partial) => {
    try {
      const config = savePrintShareConfig(app, partial);
      hostFiscalMem = { key: null, params: null, at: 0 };
      hostLabelMem = { key: null, params: null, at: 0 };
      healthFailAt.clear();
      lastRemotePrintFailAt = 0;
      lastRemoteLabelFailAt = 0;
      sessionGoodHost.clear();
      const applied = await applyServerState(app);
      const status = await shareStatusWithRename(app);
      if (config.mode === 'share' && !applied.success) {
        return { success: false, error: `No se pudo abrir el puerto ${config.sharePort}: ${applied.error}`, config, status };
      }
      return { success: true, config, status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('print-share-status', async () => shareStatusWithRename(app));

  // Dimensiones/estilo de la impresora de etiquetas de la anfitriona: el front
  // del cliente renderiza el sticker con el formato de ALLÁ antes de enviarlo.
  ipcMain.handle('print-share-label-params', async () => {
    try {
      return { success: true, params: await getRemoteLabelParams(app) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('print-share-check-host', async (event, hostIp, hostPort, fallbackIps) => {
    return checkHost(app, hostIp, hostPort, fallbackIps);
  });

  // Renombrar el equipo Windows (pide UAC). El nombre se aplica al reiniciar.
  ipcMain.handle('print-share-rename-computer', async (event, newNameRaw) => {
    try {
      if (process.platform !== 'win32') {
        return { success: false, error: 'Solo disponible en Windows.' };
      }
      const newName = String(newNameRaw || '').trim().toUpperCase();
      if (!COMPUTER_NAME_RE.test(newName) || /-$/.test(newName)) {
        return { success: false, error: 'Nombre inválido: 1-15 letras/números/guiones, empieza por letra y no termina en guion.' };
      }
      if (newName === String(os.hostname()).toUpperCase()) {
        return { success: false, error: 'El equipo ya se llama así.' };
      }
      const result = await renameComputer(newName);
      if (!result.success) return result;
      console.log(`✅ [PRINT-SHARE] Equipo renombrado a ${newName} (pendiente de reinicio)`);
      return { success: true, newName, pendingReboot: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Abrir el firewall de Windows para tickets (share) + fiscal (flask).
  ipcMain.handle('print-share-firewall-allow', async () => {
    try {
      if (process.platform !== 'win32') {
        return { success: false, error: 'Solo disponible en Windows.' };
      }
      const cfg = loadPrintShareConfig(app);
      const fiscalPort = parseFiscalPort((readSettings(app).fiscal || {}).serverUrl);
      const result = await allowFirewall(app, cfg.sharePort, fiscalPort);
      if (result.success) {
        console.log(`✅ [PRINT-SHARE] Firewall permitido (tickets :${cfg.sharePort}, fiscal :${fiscalPort})`);
        return { ...result, sharePort: cfg.sharePort, fiscalPort };
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Reiniciar Windows (para aplicar el nombre nuevo). 10s de aviso.
  ipcMain.handle('print-share-reboot', async () => {
    try {
      const { execFile } = require('child_process');
      execFile('shutdown', ['/r', '/t', '10', '/c', 'TitanioPOS: aplicando el nuevo nombre del equipo'], { windowsHide: true });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log('✅ [PRINT-SHARE] Handlers registered');
}

async function maybeStartPrintShareServer(app) {
  appRef = app;
  try {
    const result = await applyServerState(app);
    if (result && result.port) {
      console.log('🖨️ [PRINT-SHARE] Auto-start en puerto', result.port);
    }
  } catch (e) {
    console.warn('[PRINT-SHARE] Auto-start falló:', e.message);
  }
}

module.exports = {
  registerPrintShareHandlers,
  maybeStartPrintShareServer,
  loadPrintShareConfig,
  getRemoteTicketTarget,
  sendRemotePrint,
  getRemoteLabelTarget,
  sendRemoteLabelPrint,
  getRemoteLabelParams,
  getRemoteFiscalTarget,
  getRemoteFiscalParams,
  getShareStatus,
};
