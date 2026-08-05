/**
 * TitanioPOS - Impresión en red entre cajas (sección printShare del settings).
 *
 * Modo 'share' (caja anfitriona): mini servidor HTTP en 0.0.0.0:sharePort.
 *   GET  /health -> identidad + config de ticket + parámetros fiscales del host
 *   POST /print  -> { content, options } imprime en la térmica local
 *
 * Modo 'receive' (caja cliente): printer-handlers reenvía los tickets aquí
 * (sendRemotePrint) y fiscal-handlers pide la URL/params remotos
 * (getRemoteFiscalTarget / getRemoteFiscalParams). Las peticiones fiscales van
 * DIRECTO al servidor Flask de la anfitriona (ya escucha en 0.0.0.0); el
 * servidor de este módulo solo comparte la térmica y publica los parámetros.
 */

const { ipcMain } = require('electron');
const http = require('http');
const os = require('os');
const {
  readSettings,
  writeSettings,
  normalizePrintShare,
} = require('./titaniopos-settings-file');

const MAX_PRINT_BODY = 2 * 1024 * 1024;
const REMOTE_PRINT_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 4000;
const HOST_FISCAL_TTL_MS = 60000;

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
// Snapshot en memoria de los params fiscales de la anfitriona (modo receive).
let hostFiscalMem = { params: null, at: 0 };

const loadPrintShareConfig = (app) => normalizePrintShare(readSettings(app).printShare);

const savePrintShareConfig = (app, partial) => {
  const s = readSettings(app);
  s.printShare = normalizePrintShare({
    ...s.printShare,
    ...(partial && typeof partial === 'object' ? partial : {}),
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

function buildHealthPayload(app) {
  const settings = readSettings(app);
  const thermal = settings.thermalPrinter || {};
  const fiscal = settings.fiscal || {};
  return {
    ok: true,
    app: 'titaniopos-print-share',
    version: app.getVersion(),
    hostname: os.hostname(),
    mode: normalizePrintShare(settings.printShare).mode,
    ticket: {
      configured: Boolean(thermal.printerName),
      printerName: thermal.printerName || '',
      paperWidth: thermal.paperWidth || '80mm',
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

function httpJsonRequest({ hostname, port, path, method, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
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
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = { message: raw }; }
          resolve({ statusCode: res.statusCode || 500, data });
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Sin respuesta en ${Math.round(timeoutMs / 1000)}s`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
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
        const respond = (status, obj) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        if (req.method === 'GET' && req.url === '/health') {
          try {
            respond(200, buildHealthPayload(app));
          } catch (e) {
            respond(500, { ok: false, error: e.message });
          }
          return;
        }
        if (req.method === 'POST' && req.url === '/print') {
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
              // Lazy require: printer-handlers también requiere este módulo.
              const { printWithConfiguredPrinter } = require('./printer-handlers');
              const result = await printWithConfiguredPrinter(app, body.content);
              console.log('🖨️ [PRINT-SHARE] Job remoto de', req.socket.remoteAddress, '->', result.success ? 'OK' : result.error);
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
  if (cfg.mode === 'share') {
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

// ==================== CLIENTE (modo 'receive') ====================

/** {hostIp, hostPort} si esta caja manda los TICKETS a otra; null si no. */
function getRemoteTicketTarget(app) {
  const cfg = loadPrintShareConfig(app);
  if (cfg.mode === 'receive' && cfg.useRemoteTicket && cfg.hostIp) {
    return { hostIp: cfg.hostIp, hostPort: cfg.hostPort };
  }
  return null;
}

async function sendRemotePrint(target, content, options = {}) {
  try {
    const { statusCode, data } = await httpJsonRequest({
      hostname: target.hostIp,
      port: target.hostPort,
      path: '/print',
      method: 'POST',
      body: { content, options },
      timeoutMs: REMOTE_PRINT_TIMEOUT_MS,
    });
    if (statusCode >= 200 && statusCode < 300 && data && data.success) {
      return { ...data, remote: true };
    }
    const detail = (data && (data.error || data.message)) || `HTTP ${statusCode}`;
    return { success: false, remote: true, error: `La caja anfitriona no pudo imprimir: ${detail}` };
  } catch (e) {
    return {
      success: false,
      remote: true,
      error: `No se pudo imprimir en la caja anfitriona (${target.hostIp}:${target.hostPort}): ${e.message}`,
    };
  }
}

/** URL del servidor fiscal remoto si esta caja usa la fiscal de otra; null si no. */
function getRemoteFiscalTarget(app) {
  const cfg = loadPrintShareConfig(app);
  if (!(cfg.mode === 'receive' && cfg.useRemoteFiscal && cfg.hostIp)) return null;
  const port =
    (hostFiscalMem.params && hostFiscalMem.params.port) ||
    (cfg.hostFiscal && cfg.hostFiscal.port) ||
    3005;
  return { url: `http://${cfg.hostIp}:${port}`, hostIp: cfg.hostIp };
}

function persistHostFiscal(app, params) {
  try {
    const s = readSettings(app);
    const current = s.printShare && s.printShare.hostFiscal;
    if (JSON.stringify(current) === JSON.stringify(params)) return;
    s.printShare = normalizePrintShare({ ...s.printShare, hostFiscal: params });
    writeSettings(app, s);
  } catch (e) {
    console.warn('[PRINT-SHARE] No se pudo persistir hostFiscal:', e.message);
  }
}

/**
 * Parámetros fiscales de la caja anfitriona (fiscalMode, barcode, formato…).
 * Refresca por /health con caché de 60s; si el host no responde cae al último
 * snapshot conocido (memoria -> settings). null si no aplica el modo remoto.
 */
async function getRemoteFiscalParams(app, { refresh = false } = {}) {
  const cfg = loadPrintShareConfig(app);
  if (!(cfg.mode === 'receive' && cfg.useRemoteFiscal && cfg.hostIp)) return null;
  const now = Date.now();
  if (!refresh && hostFiscalMem.params && now - hostFiscalMem.at < HOST_FISCAL_TTL_MS) {
    return hostFiscalMem.params;
  }
  try {
    const { statusCode, data } = await httpJsonRequest({
      hostname: cfg.hostIp,
      port: cfg.hostPort,
      path: '/health',
      method: 'GET',
      timeoutMs: HEALTH_TIMEOUT_MS,
    });
    if (statusCode === 200 && data && data.fiscal) {
      const params = pickHostFiscalParams(data.fiscal);
      hostFiscalMem = { params, at: now };
      persistHostFiscal(app, params);
      return params;
    }
  } catch (e) {
    console.warn('[PRINT-SHARE] /health de la anfitriona no responde:', e.message);
  }
  if (hostFiscalMem.params) return hostFiscalMem.params;
  return cfg.hostFiscal || null;
}

async function checkHost(app, hostIp, hostPort) {
  const ip = String(hostIp || '').trim();
  const port = parseInt(hostPort, 10) || 3020;
  if (!ip) return { success: false, error: 'Indica la IP de la caja anfitriona' };
  try {
    const { statusCode, data } = await httpJsonRequest({
      hostname: ip, port, path: '/health', method: 'GET', timeoutMs: HEALTH_TIMEOUT_MS,
    });
    if (statusCode !== 200 || !data || data.app !== 'titaniopos-print-share') {
      return { success: false, error: `Respondió algo que no es una caja compartiendo (HTTP ${statusCode})` };
    }
    if (data.mode !== 'share') {
      return { success: false, error: `La caja ${data.hostname} no está en modo compartir` };
    }
    // Probar también el servidor fiscal Flask de la anfitriona (puerto aparte).
    let fiscalReachable = false;
    if (data.fiscal && data.fiscal.enabled) {
      try {
        const probe = await httpJsonRequest({
          hostname: ip, port: data.fiscal.port, path: '/health', method: 'GET', timeoutMs: 3000,
        });
        fiscalReachable = probe.statusCode === 200;
      } catch { fiscalReachable = false; }
    }
    // Guardar el snapshot fiscal si esta caja apunta (o va a apuntar) a este host.
    const params = pickHostFiscalParams(data.fiscal);
    const cfg = loadPrintShareConfig(app);
    if (!cfg.hostIp || cfg.hostIp === ip) {
      hostFiscalMem = { params, at: Date.now() };
      persistHostFiscal(app, params);
    }
    return { success: true, health: data, fiscalReachable };
  } catch (e) {
    return { success: false, error: `Sin conexión con ${ip}:${port} (${e.message})` };
  }
}

// ==================== IPC ====================

function registerPrintShareHandlers(app) {
  ipcMain.handle('print-share-config-get', async () => {
    try {
      return { success: true, config: loadPrintShareConfig(app), status: getShareStatus(app) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('print-share-config-save', async (event, partial) => {
    try {
      const config = savePrintShareConfig(app, partial);
      hostFiscalMem = { params: null, at: 0 };
      const applied = await applyServerState(app);
      const status = getShareStatus(app);
      if (config.mode === 'share' && !applied.success) {
        return { success: false, error: `No se pudo abrir el puerto ${config.sharePort}: ${applied.error}`, config, status };
      }
      return { success: true, config, status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('print-share-status', async () => getShareStatus(app));

  ipcMain.handle('print-share-check-host', async (event, hostIp, hostPort) => {
    return checkHost(app, hostIp, hostPort);
  });

  console.log('✅ [PRINT-SHARE] Handlers registered');
}

async function maybeStartPrintShareServer(app) {
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
  getRemoteFiscalTarget,
  getRemoteFiscalParams,
  getShareStatus,
};
