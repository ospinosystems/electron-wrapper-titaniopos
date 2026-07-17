/**
 * Caja y config fiscal: Documentos/TitanioPOS-Settings/titaniopos-settings.json
 * Cola de respuestas fiscales (HKA): mismo directorio, fiscal-responses.json (aparte; no se mezcla con caja)
 */

const path = require('path');
const fs = require('fs');

const SETTINGS_DIR = 'TitanioPOS-Settings';
const SETTINGS_FILENAME = 'titaniopos-settings.json';

/** @deprecated - migración */
const LEGACY_CAJA_DIR = 'TitanioPOS-Caja';
const LEGACY_FISCAL_DIR = 'TitanioPOS-Fiscal';
const FISCAL_CONFIG_FILE = 'fiscal-config.json';
const FISCAL_RESPONSES_FILE = 'fiscal-responses.json';

const DEFAULT_CAJA = {
  cashRegisterNumber: null,
  pinpadIp: null,
  operationMode: 'POS',
};

const DEFAULT_FISCAL = {
  enabled: false,
  fiscalMode: false,
  comPort: 'COM1',
  serverUrl: 'http://localhost:3000',
  storeCode: '',
  cashRegisterNumber: '',
  lastConfigUpdate: '',
  // Controla si el server Python arranca con la app. OFF por defecto para
  // no afectar rendimiento en PCs viejas que no usan facturación fiscal.
  serverEnabled: false,
  // Código de barras en la factura fiscal HKA80 con el nº de orden (últimos dígitos
  // del UUID). ON por defecto; se apaga poniendo printBarcode:false en Ajustes.
  printBarcode: true,
  // Comando exacto del código de barras. Formato HKA80 validado:
  // 'j<tipo><posición><texto>{code}' (tipo 2=CODE128, posición 0=cuerpo 1=pie,
  // texto 0=sin número 1=con número). {code} = número de orden.
  // Default: barra al pie con el número debajo.
  barcodeRaw: 'j211{code}',
  // Forzar máquina fiscal: cuando ON, cada venta procesada emite factura fiscal
  // automáticamente y cada devolución emite su nota de crédito, sin depender de
  // que el cajero pulse "Facturar". OFF por defecto (comportamiento manual).
  forceFiscal: false,
  // Código HKA del medio de pago en DIVISA que dispara el IGTF (3%). El protocolo
  // The Factory HKA usa medios de pago 20-24 para divisa; 20 es el default.
  // El cierre de una factura pagada en divisa se envía como '1'+este código
  // (ej. '120') y la impresora calcula e imprime el IGTF sola.
  // NOTA: validar contra la máquina real (modelo/firmware) en la pre-instalación.
  igtfDivisaCode: '20',
  // IGTF activo: manda el código de divisa (arriba) para disparar el 3% en la HKA
  // SOLO cuando la máquina tiene ese medio de pago programado. OFF hasta la
  // pre-instalación; mientras, los pagos en divisa cierran como efectivo (01).
  igtfEnabled: false,
  // Serial de la impresora fiscal (ej. 'ZPA2000343'). Requerido en la NOTA DE
  // CRÉDITO (campo iI*): identifica la máquina que emitió la factura original.
  // Se configura una vez por caja en Ajustes → Caja.
  machineSerial: '',
};

const DEFAULT_UI = {
  reduceAnimations: false,
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
  serverPort: '4763',
  ssl: true,
  vtid: '',
  id: '',
  lastConfigUpdate: '',
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  caja: { ...DEFAULT_CAJA },
  fiscal: { ...DEFAULT_FISCAL },
  ui: { ...DEFAULT_UI },
  megaPos: { ...DEFAULT_MEGA_POS },
};


function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function normalizeCaja(raw) {
  const base = { ...DEFAULT_CAJA, ...raw };
  return {
    cashRegisterNumber: base.cashRegisterNumber ?? null,
    pinpadIp: base.pinpadIp ?? null,
    operationMode: base.operationMode === 'SELF_SERVICE' ? 'SELF_SERVICE' : 'POS',
  };
}

function normalizeFiscal(raw) {
  const base = { ...DEFAULT_FISCAL, ...raw };
  return {
    ...base,
    forceFiscal: Boolean(base.forceFiscal),
    igtfEnabled: Boolean(base.igtfEnabled),
    // Solo dígitos; si queda vacío cae al default (20 = divisa).
    igtfDivisaCode: String(base.igtfDivisaCode ?? '').replace(/\D/g, '') || DEFAULT_FISCAL.igtfDivisaCode,
    // Serial alfanumérico, en mayúsculas, sin espacios.
    machineSerial: String(base.machineSerial ?? '').trim().toUpperCase(),
  };
}

function normalizeUi(raw) {
  return { ...DEFAULT_UI, ...(raw || {}) };
}

function normalizeMegaPos(raw) {
  const base = { ...DEFAULT_MEGA_POS, ...(raw || {}) };
  return {
    enabled: Boolean(base.enabled),
    // Host/puerto vacíos (configs guardadas antes de tener defaults) caen al
    // Merchant Server de producción.
    serverHost: String(base.serverHost || DEFAULT_MEGA_POS.serverHost),
    serverPort: String(base.serverPort || DEFAULT_MEGA_POS.serverPort),
    ssl: base.ssl === undefined || base.ssl === null ? true : Boolean(base.ssl),
    vtid: String(base.vtid ?? ''),
    id: String(base.id ?? ''),
    lastConfigUpdate: String(base.lastConfigUpdate ?? ''),
  };
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_SETTINGS);
  return {
    schemaVersion: raw.schemaVersion ?? 1,
    caja: normalizeCaja(raw.caja || {}),
    fiscal: normalizeFiscal(raw.fiscal || {}),
    ui: normalizeUi(raw.ui || {}),
    megaPos: normalizeMegaPos(raw.megaPos || raw.smartPos || {}),
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
function readSettings(app) {
  const p = getSettingsPath(app);
  try {
    if (fs.existsSync(p)) {
      const data = fs.readFileSync(p, 'utf-8').trim();
      if (data) {
        return normalizeSettings(JSON.parse(data));
      }
    }
  } catch (e) {
    console.error('[SETTINGS] Error leyendo:', e);
  }
  return clone(DEFAULT_SETTINGS);
}

function writeSettings(app, next) {
  if (next && typeof next === 'object' && 'fiscalResponses' in next) {
    const { fiscalResponses, ...rest } = next;
    next = rest;
  }
  const normalized = normalizeSettings(next);
  const p = getSettingsPath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(normalized, null, 2), 'utf-8');
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
  const p = getFiscalResponsesPath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.isArray(responses) ? responses : [], null, 2), 'utf-8');
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
    const cajaDir = path.join(documentsPath, LEGACY_CAJA_DIR);
    const legacyFiscalDir = path.join(documentsPath, LEGACY_FISCAL_DIR);

    const legacyCandidatePaths = [
      path.join(legacyFiscalDir, FISCAL_CONFIG_FILE),
      path.join(legacyFiscalDir, FISCAL_RESPONSES_FILE),
      path.join(cajaDir, 'caja-config.json'),
      path.join(cajaDir, FISCAL_CONFIG_FILE),
      path.join(cajaDir, FISCAL_RESPONSES_FILE),
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
  normalizeFiscal,
  normalizeUi,
  normalizeMegaPos,
  DEFAULT_SETTINGS,
  DEFAULT_CAJA,
  DEFAULT_UI,
  DEFAULT_MEGA_POS,
  migrateToUnifiedSettings,
  SETTINGS_DIR,
  SETTINGS_FILENAME,
};
