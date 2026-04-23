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
  method: 'escpos',
  paperWidth: '80mm',
  lastUpdated: null,
};

const DEFAULT_FISCAL = {
  enabled: false,
  fiscalMode: false,
  comPort: 'COM1',
  serverUrl: 'http://localhost:3000',
  storeCode: '',
  cashRegisterNumber: '',
  lastConfigUpdate: '',
};

const DEFAULT_SETTINGS = {
  schemaVersion: 1,
  caja: { ...DEFAULT_CAJA },
  thermalPrinter: { ...DEFAULT_THERMAL },
  fiscal: { ...DEFAULT_FISCAL },
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

function normalizeThermal(raw) {
  return { ...DEFAULT_THERMAL, ...raw };
}

function normalizeFiscal(raw) {
  return { ...DEFAULT_FISCAL, ...raw };
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return clone(DEFAULT_SETTINGS);
  return {
    schemaVersion: raw.schemaVersion ?? 1,
    caja: normalizeCaja(raw.caja || {}),
    thermalPrinter: normalizeThermal(raw.thermalPrinter || raw.printer || {}),
    fiscal: normalizeFiscal(raw.fiscal || {}),
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
  normalizeFiscal,
  DEFAULT_SETTINGS,
  DEFAULT_CAJA,
  migrateToUnifiedSettings,
  SETTINGS_DIR,
  SETTINGS_FILENAME,
};
