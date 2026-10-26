/**
 * TitanioPOS - Encendido del modo directo de la tickera
 *
 * El modo directo (bin/printer-direct-mode.ps1, aplicado por la tarea SYSTEM
 * de soporte remoto) solo actúa donde `printerDirectMode.enabled` es true en
 * titaniopos-settings.json. Este módulo enciende esa bandera, una sola vez y
 * al arrancar la app:
 *
 *  - PILOT_ALL = true  → en TODAS las cajas (desde 1.0.260). Las que lo reciben
 *    así quedan marcadas `pilot: "all:<tienda>/<equipo>"`.
 *  - Cajas de la lista PILOT → `pilot: "<tienda>/<equipo>"` (las primeras pruebas).
 *  - `enabled` ya decidido (true o false) nunca se pisa: así el comando remoto
 *    `printer_direct_mode` del bus (que escribe la bandera por IPC, ver
 *    printer-handlers.js) puede apagarlo en una caja, una tienda o todas, y
 *    este módulo no lo vuelve a encender en el siguiente arranque.
 */

const os = require('os');

/** Cajas piloto: código de tienda (settings.caja.storeCode) + nombre de equipo. */
const PILOT = [
  { store: 'calabozo2', host: 'caja1' },
  // Prueba en tienda (2026-10-23): Anaco caja 2. Se incluyen las dos tiendas
  // Anaco (anaco, anaco2) porque la prueba se hace en "Anaco caja 2" y el
  // equipo se llama CAJA2.
  { store: 'anaco', host: 'caja2' },
  { store: 'anaco2', host: 'caja2' },
];

/** true = encender en toda la flota (desde 1.0.260, a pedido del usuario). */
const PILOT_ALL = true;

const FLEET_PREFIX = 'all:';

const norm = (v) => String(v || '').trim().toLowerCase();

function isPilotMatch(storeCode, hostname, list = PILOT, all = PILOT_ALL) {
  if (all) return true;
  const store = norm(storeCode);
  const host = norm(hostname);
  if (!store || !host) return false;
  return (list || []).some((p) => norm(p.store) === store && norm(p.host) === host);
}

/**
 * Enciende `printerDirectMode.enabled` en esta caja si nadie lo decidió aún.
 * Nunca lanza. `deps` se inyecta en los tests: settings, hostname, list, all.
 */
function applyPrinterDirectPilot(app, deps = {}) {
  try {
    const settings = deps.settings || require('./titaniopos-settings-file');
    const hostname = deps.hostname || os.hostname();
    const list = deps.list || PILOT;
    const all = deps.all !== undefined ? deps.all : PILOT_ALL;
    const s = settings.readSettings(app);
    const current = s.printerDirectMode || {};
    if (current.enabled === true || current.enabled === false) {
      return { changed: false, enabled: current.enabled, reason: 'already-set' };
    }
    const storeCode = s.caja && s.caja.storeCode;
    const inList = isPilotMatch(storeCode, hostname, list, false);
    const byFleet = !inList && all;
    if (!inList && !byFleet) {
      return { changed: false, enabled: null, reason: 'not-pilot' };
    }
    const id = `${norm(storeCode)}/${norm(hostname)}`;
    s.printerDirectMode = {
      ...current,
      enabled: true,
      pilot: byFleet ? `${FLEET_PREFIX}${id}` : id,
      at: new Date().toISOString(),
    };
    settings.writeSettings(app, s);
    console.log(`🧪 [PRINT-DIRECT] ${byFleet ? 'Flota' : 'Caja piloto'} ${storeCode}/${hostname}: modo directo habilitado (lo aplica la tarea SYSTEM)`);
    return { changed: true, enabled: true, reason: byFleet ? 'fleet' : 'pilot' };
  } catch (e) {
    console.warn('⚠️ [PRINT-DIRECT] piloto:', e && e.message);
    return { changed: false, enabled: null, reason: 'error', error: e && e.message };
  }
}

/**
 * Fija la bandera a pedido (comando remoto `printer_direct_mode` del bus).
 * `enabled` false = volver al modo normal de Windows; true = modo directo.
 * La tarea SYSTEM lo aplica en su siguiente pasada (arranque, inicio de sesión
 * o cada 2 h): la app no tiene permisos para tocar la impresora. Nunca lanza.
 */
function setPrinterDirectMode(app, enabled, deps = {}) {
  try {
    if (enabled !== true && enabled !== false) {
      return { success: false, error: 'enabled debe ser true o false' };
    }
    const settings = deps.settings || require('./titaniopos-settings-file');
    const s = settings.readSettings(app);
    const previous = s.printerDirectMode && typeof s.printerDirectMode.enabled === 'boolean' ? s.printerDirectMode.enabled : null;
    s.printerDirectMode = { ...(s.printerDirectMode || {}), enabled, pilot: 'remote', at: new Date().toISOString() };
    settings.writeSettings(app, s);
    console.log(`📡 [PRINT-DIRECT] Comando remoto: modo directo ${enabled ? 'ENCENDIDO' : 'APAGADO'} (antes: ${previous})`);
    return { success: true, enabled, previous };
  } catch (e) {
    return { success: false, error: e && e.message };
  }
}

module.exports = { PILOT, PILOT_ALL, isPilotMatch, applyPrinterDirectPilot, setPrinterDirectMode };
