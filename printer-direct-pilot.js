/**
 * TitanioPOS - Piloto del modo directo de la tickera
 *
 * El release del Electron llega a TODAS las cajas (GitHub Releases, instalación
 * silenciosa post-cierre), así que no hay forma de mandar un cambio a una sola.
 * Por eso el modo directo (bin/printer-direct-mode.ps1, aplicado por la tarea
 * SYSTEM de soporte remoto) solo actúa donde `printerDirectMode.enabled` es
 * true en titaniopos-settings.json. Este módulo enciende esa bandera, una sola
 * vez y al arrancar, en las cajas de la lista PILOT (tienda + nombre de
 * equipo). El resto de la flota queda exactamente como hoy.
 *
 * Para extender: agregar cajas a PILOT, o PILOT_ALL = true para toda la flota.
 * `enabled` ya decidido (true o false, p. ej. puesto por soporte) nunca se pisa.
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

/** true = encender en toda la flota (ya no hace falta la lista). */
const PILOT_ALL = false;

const norm = (v) => String(v || '').trim().toLowerCase();

function isPilotMatch(storeCode, hostname, list = PILOT, all = PILOT_ALL) {
  if (all) return true;
  const store = norm(storeCode);
  const host = norm(hostname);
  if (!store || !host) return false;
  return (list || []).some((p) => norm(p.store) === store && norm(p.host) === host);
}

/**
 * Enciende `printerDirectMode.enabled` en la caja si es piloto y nadie lo ha
 * decidido aún. Nunca lanza. `deps` se inyecta en los tests.
 */
function applyPrinterDirectPilot(app, deps = {}) {
  try {
    const settings = deps.settings || require('./titaniopos-settings-file');
    const hostname = deps.hostname || os.hostname();
    const s = settings.readSettings(app);
    const current = s.printerDirectMode || {};
    if (current.enabled === true || current.enabled === false) {
      return { changed: false, enabled: current.enabled, reason: 'already-set' };
    }
    const storeCode = s.caja && s.caja.storeCode;
    if (!isPilotMatch(storeCode, hostname, deps.list, deps.all)) {
      return { changed: false, enabled: null, reason: 'not-pilot' };
    }
    s.printerDirectMode = { ...current, enabled: true, pilot: `${norm(storeCode)}/${norm(hostname)}`, at: new Date().toISOString() };
    settings.writeSettings(app, s);
    console.log(`🧪 [PRINT-DIRECT] Caja piloto ${storeCode}/${hostname}: modo directo habilitado (lo aplica la tarea SYSTEM)`);
    return { changed: true, enabled: true, reason: 'pilot' };
  } catch (e) {
    console.warn('⚠️ [PRINT-DIRECT] piloto:', e && e.message);
    return { changed: false, enabled: null, reason: 'error', error: e && e.message };
  }
}

module.exports = { PILOT, PILOT_ALL, isPilotMatch, applyPrinterDirectPilot };
