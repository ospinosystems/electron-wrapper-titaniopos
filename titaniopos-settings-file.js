/**
 * Caja, impresora térmica y config fiscal: Documentos/TitanioPOS-Settings/titaniopos-settings.json
 * Cola de respuestas fiscales (HKA): mismo directorio, fiscal-responses.json (aparte; no se mezcla con caja/thermal)
 */

const path = require('path');
const fs = require('fs');

const SETTINGS_DIR = 'TitanioPOS-Settings';
const SETTINGS_FILENAME = 'titaniopos-settings.json';

/** @deprecated - migración */
const LEGACY_CAJA_DIR = 'TitanioPOS-Caja';
const LEGACY_FISCAL_DIR = 'TitanioPOS-Fiscal';
const LEGACY_USERDATA_PRINTER = 'printer-config.json';
const THERMAL_PRINTER_FILE = 'thermal-printer.json';
const FISCAL_CONFIG_FILE = 'fiscal-config.json';
const FISCAL_RESPONSES_FILE = 'fiscal-responses.json';

const DEFAULT_CAJA = {
  cashRegisterNumber: null,
  pinpadIp: null,
  operationMode: 'POS',
};

const DEFAULT_THERMAL = {
  printerName: '',
  usbPort: 'USB003',
  // Direct EXE (winspool RAW): el método más confiable y rápido. El handler
  // igual auto-promueve escpos→direct cuando el helper está disponible.
  method: 'direct',
  paperWidth: '80mm',
  debugPdf: false,
  lastUpdated: null,
};

const DEFAULT_FISCAL = {
  enabled: false,
  fiscalMode: false,
  comPort: 'COM1',
  // Puerto real del fiscal-server empaquetado (fiscal-server/.env). 127.0.0.1
  // explícito para evitar la resolución IPv6 de 'localhost'.
  serverUrl: 'http://127.0.0.1:3005',
  storeCode: '',
  cashRegisterNumber: '',
  lastConfigUpdate: '',
  // Controla si el server Python arranca con la app. OFF por defecto para
  // no afectar rendimiento en PCs viejas que no usan facturación fiscal.
  serverEnabled: false,
  // Código de barras en la factura fiscal HKA80 (autopago). OFF por defecto.
  printBarcode: false,
  // Comando exacto del código de barras. Formato HKA80 validado:
  // 'j<tipo><posición><texto>{code}' (tipo 2=CODE128, posición 0=cuerpo 1=pie,
  // texto 0=sin número 1=con número). {code} = número de orden.
  // Default: barra al pie con el número debajo.
  barcodeRaw: 'j211{code}',
};

const DEFAULT_UI = {
  reduceAnimations: false,
};

// Impresora de etiquetas (RC-8610). La config canónica vive en el FRONT
// (useUserConfigStore.labelPrinterConfig, localStorage) porque la eligió así la
// primera versión; este espejo en el settings existe para que el proceso main
// pueda imprimir etiquetas SIN pasar por el renderer — lo necesita el servidor
// de impresión en red (/print-label) cuando otra caja manda una etiqueta. El
// front lo sincroniza al guardar la config y al imprimir en local.
const DEFAULT_LABEL_PRINTER = {
  printerName: '',
  usbPort: 'USB003',
  method: 'native',
  widthMm: 57,
  heightMm: 44,
  layout: 'classic',
  lastUpdated: null,
};

// Smart POS (Megasoft VPOS RESTService). Estos valores se escriben en
// vpos-rest/conf/vposconf.ini antes de arrancar el servicio:
//   [server] host/port  -> Merchant Server de Megasoft (adquiriente)
//   [SSL]    active      -> conexión SSL caja-Merchant (producción la exige)
//   [vtid]   vtid        -> terminal virtual asignado por Megasoft (uno por caja)
//            id           -> número de caja en la tienda (p.ej. 0001); la
//                            afiliación bancaria NO va aquí (vive en el
//                            Merchant Server, asociada al vtid)
// Defaults = ambiente de PRODUCCIÓN (correo Megasoft 2026-07-06); solo falta
// cargar el vtid/id propio de cada caja cuando Megasoft los genere.
const DEFAULT_MEGA_POS = {
  enabled: false,
  serverHost: 'ssl.megasoftve.com',
  serverPort: '4772',
  ssl: true,
  vtid: '',
  id: '',
  lastConfigUpdate: '',
};

// Impresión en red entre cajas.
//   mode 'share'   — esta caja expone sus impresoras (ticket + fiscal) en la LAN
//                    vía un mini servidor HTTP (POST /print, GET /health).
//   mode 'receive' — esta caja manda los tickets a la caja anfitriona (hostIp) y,
//                    si useRemoteFiscal, también las peticiones fiscales van al
//                    servidor fiscal de la anfitriona.
//   hostFiscal     — último snapshot de los parámetros fiscales de la anfitriona
//                    (fiscalMode, barcode, formato, serial, puerto flask); se usa
//                    para imprimir con el formato de ALLÁ aunque no responda el
//                    /health en el momento de la venta.
const DEFAULT_PRINT_SHARE = {
  mode: 'off',
  sharePort: 3020,
  hostIp: '',
  hostPort: 3020,
  useRemoteTicket: true,
  useRemoteFiscal: false,
  // Etiquetas a la anfitriona. Default ON porque solo entra en juego cuando la
  // caja NO tiene impresora de etiquetas local (el front imprime local si la
  // tiene): compartir "simplemente funciona" igual que con la térmica.
  useRemoteLabel: true,
  hostFiscal: null,
  // Último snapshot de la impresora de etiquetas de la anfitriona (dimensiones
  // y layout): el cliente renderiza el sticker con el formato de ALLÁ aunque el
  // /health no responda en el momento.
  hostLabel: null,
  lastUpdated: null,
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  caja: { ...DEFAULT_CAJA },
  thermalPrinter: { ...DEFAULT_THERMAL },
  labelPrinter: { ...DEFAULT_LABEL_PRINTER },
  fiscal: { ...DEFAULT_FISCAL },
  ui: { ...DEFAULT_UI },
  megaPos: { ...DEFAULT_MEGA_POS },
  printShare: { ...DEFAULT_PRINT_SHARE },
};


function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeCaja(raw) {
  const base = { ...DEFAULT_CAJA, ...raw };
  const out = {
    cashRegisterNumber: base.cashRegisterNumber ?? null,
    pinpadIp: base.pinpadIp ?? null,
    operationMode: base.operationMode === 'SELF_SERVICE' ? 'SELF_SERVICE' : 'POS',
  };
  // Toggles de habilitación (megaPos/pinpad): se incluyen SOLO si el JSON ya los
  // trae. Así una caja que viene de una versión anterior (sin estos campos) NO
  // recibe un default que pise el valor real que el front trae de localStorage;
  // el front hace un backfill único con el valor bueno y a partir de ahí viven en
  // el JSON (config de la máquina) y sobreviven a un "clear site data".
  if (typeof base.megaPosEnabled === 'boolean') out.megaPosEnabled = base.megaPosEnabled;
  if (typeof base.pinpadEnabled === 'boolean') out.pinpadEnabled = base.pinpadEnabled;
  return out;
}

function normalizeThermal(raw) {
  return { ...DEFAULT_THERMAL, ...raw };
}

function normalizeLabelPrinter(raw) {
  const base = { ...DEFAULT_LABEL_PRINTER, ...(raw || {}) };
  const toMm = (v, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : def;
  };
  return {
    printerName: String(base.printerName ?? ''),
    usbPort: String(base.usbPort || DEFAULT_LABEL_PRINTER.usbPort),
    method: String(base.method || DEFAULT_LABEL_PRINTER.method),
    widthMm: toMm(base.widthMm, DEFAULT_LABEL_PRINTER.widthMm),
    heightMm: toMm(base.heightMm, DEFAULT_LABEL_PRINTER.heightMm),
    layout: String(base.layout || DEFAULT_LABEL_PRINTER.layout),
    lastUpdated: base.lastUpdated ?? null,
  };
}

function normalizeFiscal(raw) {
  return { ...DEFAULT_FISCAL, ...raw };
}

function normalizeUi(raw) {
  return { ...DEFAULT_UI, ...(raw || {}) };
}

function normalizeMegaPos(raw) {
  const base = { ...DEFAULT_MEGA_POS, ...(raw || {}) };
  return {
    enabled: Boolean(base.enabled),
    // Host/puerto vacíos (configs guardadas antes de tener defaults) caen al
    // Merchant Server de producción. El puerto 4763 fue el default anterior
    // (incorrecto): se corrige a 4772, el puerto SSL real del Merchant.
    serverHost: String(base.serverHost || DEFAULT_MEGA_POS.serverHost),
    serverPort: ((p) => (p === '4763' ? '4772' : p))(String(base.serverPort || DEFAULT_MEGA_POS.serverPort)),
    ssl: base.ssl === undefined || base.ssl === null ? true : Boolean(base.ssl),
    vtid: String(base.vtid ?? ''),
    id: String(base.id ?? ''),
    lastConfigUpdate: String(base.lastConfigUpdate ?? ''),
  };
}

function normalizePrintShare(raw) {
  const base = { ...DEFAULT_PRINT_SHARE, ...(raw || {}) };
  const toPort = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 && n <= 65535 ? n : def;
  };
  return {
    mode: base.mode === 'share' || base.mode === 'receive' ? base.mode : 'off',
    sharePort: toPort(base.sharePort, DEFAULT_PRINT_SHARE.sharePort),
    hostIp: String(base.hostIp || '').trim(),
    hostPort: toPort(base.hostPort, DEFAULT_PRINT_SHARE.hostPort),
    useRemoteTicket: base.useRemoteTicket !== false,
    useRemoteFiscal: base.useRemoteFiscal === true,
    useRemoteLabel: base.useRemoteLabel !== false,
    hostFiscal: base.hostFiscal && typeof base.hostFiscal === 'object' ? base.hostFiscal : null,
    hostLabel: base.hostLabel && typeof base.hostLabel === 'object' ? base.hostLabel : null,
    lastUpdated: base.lastUpdated ?? null,
  };
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_SETTINGS);
  return {
    schemaVersion: raw.schemaVersion ?? 1,
    caja: normalizeCaja(raw.caja || {}),
    thermalPrinter: normalizeThermal(raw.thermalPrinter || raw.printer || {}),
    labelPrinter: normalizeLabelPrinter(raw.labelPrinter || {}),
    fiscal: normalizeFiscal(raw.fiscal || {}),
    ui: normalizeUi(raw.ui || {}),
    megaPos: normalizeMegaPos(raw.megaPos || raw.smartPos || {}),
    printShare: normalizePrintShare(raw.printShare || {}),
  };
}

function getTitanioposSettingsDir(app) {
  const documentsPath = app.getPath('documents');
  const dir = path.join(documentsPath, SETTINGS_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getSettingsPath(app) {
  return path.join(getTitanioposSettingsDir(app), SETTINGS_FILENAME);
}

/**
 * @returns {typeof DEFAULT_SETTINGS}
 */
// Lee y parsea un JSON; null si no existe, está vacío o corrupto.
function readJsonOrNull(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const data = fs.readFileSync(p, 'utf-8').trim();
    return data ? JSON.parse(data) : null;
  } catch (e) {
    console.error('[SETTINGS] Error leyendo', p, ':', e.message);
    return null;
  }
}

// Escritura DURABLE: tmp + fsync + rename (nunca queda un archivo a medias) y el
// último contenido válido se conserva como .prev. Un corte de luz durante
// writeFileSync dejaba el JSON vacío/truncado → la caja arrancaba con DEFAULTS
// (fiscal apagada, COM1, sin tiquera) = "se desconfiguró sola".
function writeJsonDurable(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const json = JSON.stringify(obj, null, 2);
  const tmp = `${p}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, json, 0, 'utf-8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  // Respaldo = el estado recién escrito (válido por construcción). Si el
  // principal se pierde/corrompe, readSettings vuelve a este.
  try { fs.copyFileSync(p, `${p}.prev`); } catch (_) { /* respaldo best-effort */ }
}

function readSettings(app) {
  const p = getSettingsPath(app);
  const main = readJsonOrNull(p);
  if (main) return normalizeSettings(main);
  // Principal ausente/vacío/corrupto: recuperar desde el respaldo .prev.
  const prev = readJsonOrNull(`${p}.prev`);
  if (prev) {
    console.warn('[SETTINGS] titaniopos-settings.json inválido; restaurado desde .prev');
    try { writeJsonDurable(p, normalizeSettings(prev)); } catch (_) { /* se reintenta en el próximo write */ }
    return normalizeSettings(prev);
  }
  return clone(DEFAULT_SETTINGS);
}

function writeSettings(app, next) {
  if (next && typeof next === 'object' && 'fiscalResponses' in next) {
    const { fiscalResponses, ...rest } = next;
    next = rest;
  }
  const normalized = normalizeSettings(next);
  writeJsonDurable(getSettingsPath(app), normalized);
  return normalized;
}

function getFiscalResponsesPath(app) {
  return path.join(getTitanioposSettingsDir(app), FISCAL_RESPONSES_FILE);
}

function readFiscalResponsesFile(app) {
  const data = readSafeJson(getFiscalResponsesPath(app));
  return Array.isArray(data) ? data : [];
}

function writeFiscalResponsesFile(app, responses) {
  writeJsonDurable(getFiscalResponsesPath(app), Array.isArray(responses) ? responses : []);
}

/**
 * one-shot: leyó en versiones anteriores fiscalResponses dentro de titaniopos-settings.json
 */
function splitFiscalResponsesFromUnifiedIfPresent(app) {
  const p = getSettingsPath(app);
  if (!fs.existsSync(p)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (raw == null || typeof raw !== 'object' || !('fiscalResponses' in raw)) return;
    const fr = raw.fiscalResponses;
    delete raw.fiscalResponses;
    fs.writeFileSync(p, JSON.stringify(raw, null, 2), 'utf-8');
    if (Array.isArray(fr) && fr.length > 0) {
      const existing = readFiscalResponsesFile(app);
      if (existing.length === 0) {
        writeFiscalResponsesFile(app, fr);
      } else {
        const byId = new Map(existing.map((r) => [r.id, r]));
        for (const r of fr) {
          if (r && r.id != null && !byId.has(r.id)) byId.set(r.id, r);
        }
        writeFiscalResponsesFile(app, Array.from(byId.values()));
      }
      console.log('[SETTINGS] Cola fiscal migrada a', getFiscalResponsesPath(app));
    }
  } catch (e) {
    console.warn('[SETTINGS] splitFiscalResponsesFromUnifiedIfPresent:', e.message);
  }
}

function readSafeJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const t = fs.readFileSync(filePath, 'utf-8').trim();
    if (!t) return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/**
 * Construye el archivo unificado la primera vez: desde su propio .json, TitanioPOS-Caja, TitanioPOS-Fiscal, AppData.
 */
function migrateToUnifiedSettings(app) {
  try {
    const target = getSettingsPath(app);
    if (fs.existsSync(target)) {
      return;
    }

    const documentsPath = app.getPath('documents');
    const userData = app.getPath('userData');
    const cajaDir = path.join(documentsPath, LEGACY_CAJA_DIR);
    const legacyFiscalDir = path.join(documentsPath, LEGACY_FISCAL_DIR);
    const oldPrinter = path.join(userData, LEGACY_USERDATA_PRINTER);

    const legacyCandidatePaths = [
      path.join(legacyFiscalDir, FISCAL_CONFIG_FILE),
      path.join(legacyFiscalDir, FISCAL_RESPONSES_FILE),
      path.join(cajaDir, 'caja-config.json'),
      path.join(cajaDir, THERMAL_PRINTER_FILE),
      path.join(cajaDir, FISCAL_CONFIG_FILE),
      path.join(cajaDir, FISCAL_RESPONSES_FILE),
      oldPrinter,
    ];
    const hasLegacyFiles = legacyCandidatePaths.some(
      (p) => fs.existsSync(p) && fs.statSync(p).size > 0,
    );
    if (!hasLegacyFiles) {
      return;
    }

    const merged = clone(DEFAULT_SETTINGS);

    const fLegacy = readSafeJson(path.join(legacyFiscalDir, FISCAL_CONFIG_FILE));
    if (fLegacy) merged.fiscal = normalizeFiscal(fLegacy);

    const rLegacy = readSafeJson(path.join(legacyFiscalDir, FISCAL_RESPONSES_FILE));
    let collectedResponses = Array.isArray(rLegacy) ? rLegacy : null;

    const cCaja = readSafeJson(path.join(cajaDir, 'caja-config.json'));
    if (cCaja) merged.caja = normalizeCaja(cCaja);

    const tCaja = readSafeJson(path.join(cajaDir, 'thermal-printer.json'));
    if (tCaja) {
      merged.thermalPrinter = normalizeThermal(tCaja);
    } else {
      const tUser = readSafeJson(oldPrinter);
      if (tUser) merged.thermalPrinter = normalizeThermal(tUser);
    }

    const fCaja = readSafeJson(path.join(cajaDir, FISCAL_CONFIG_FILE));
    if (fCaja) merged.fiscal = normalizeFiscal(fCaja);

    const rCaja = readSafeJson(path.join(cajaDir, FISCAL_RESPONSES_FILE));
    if (Array.isArray(rCaja)) collectedResponses = rCaja;

    writeSettings(app, merged);
    if (Array.isArray(collectedResponses) && collectedResponses.length > 0) {
      writeFiscalResponsesFile(app, collectedResponses);
    }
    console.log('[SETTINGS] Archivo unificado creado en', target);
  } catch (e) {
    console.warn('[SETTINGS] Migración:', e.message);
  }
}

module.exports = {
  getTitanioposSettingsDir,
  getSettingsPath,
  getFiscalResponsesPath,
  readSettings,
  writeSettings,
  readFiscalResponsesFile,
  writeFiscalResponsesFile,
  splitFiscalResponsesFromUnifiedIfPresent,
  normalizeCaja,
  normalizeThermal,
  normalizeLabelPrinter,
  normalizeFiscal,
  normalizeUi,
  normalizeMegaPos,
  normalizePrintShare,
  DEFAULT_SETTINGS,
  DEFAULT_CAJA,
  DEFAULT_UI,
  DEFAULT_MEGA_POS,
  DEFAULT_PRINT_SHARE,
  migrateToUnifiedSettings,
  SETTINGS_DIR,
  SETTINGS_FILENAME,
};
