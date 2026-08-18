/**
 * boot-watchdog.js — detecta que la UI no arrancó y ofrece repararla.
 *
 * POR QUÉ EXISTE (caso real, 13/08/2026): tras un apagón, una caja abría en
 * blanco con decenas de `Invalid or unexpected token`. El HTML cargaba bien
 * —para Electron era un `did-finish-load` exitoso— y lo que reventaba era el
 * JavaScript, así que NADIE se enteraba: ni `did-fail-load`, ni el updater, ni
 * el proxy. Borrar `views\` no sirvió; reinstalar encima tampoco. Lo único que
 * la levantó fue borrar el perfil de Electron (`%APPDATA%\titaniopos-electron`),
 * que es donde vive el `Code Cache` con el JS ya compilado por Chromium. Un día
 * de trabajo por algo que se resuelve en 20 segundos si uno sabe dónde tocar.
 *
 * CÓMO FUNCIONA: el front avisa `TITANIO_APP_READY` apenas React monta (o sea,
 * apenas el JS se ejecutó, que es justo lo que se está comprobando). Si esa
 * señal no llega, o si aparecen errores de sintaxis en consola, se muestra una
 * PANTALLA DE ERROR con UN BOTÓN. Nada se repara solo: la reparación la dispara
 * la persona, así se ve qué hizo y si sirvió.
 *
 * El botón escala un nivel por intento:
 *   1. cachés de Chromium (Code Cache, HTTP cache, service workers) → recargar
 *   2. descartar la vista descargada → arrancar con la horneada → relanzar
 *   3. perfil completo (localStorage, IndexedDB, cookies…)         → relanzar
 *
 * El nivel se persiste en `<userData>/boot-heal.json` y se resetea en cuanto un
 * arranque llega a READY. Agotado el 3, la pantalla lo dice y deja de ofrecer
 * reparaciones: ahí hay que mirar la caja a mano.
 *
 * NADA DE ESTO PIERDE VENTAS. Las órdenes viven firmadas en
 * `Documents\TitanioPOS-Backups\backup_<fecha>.json` y ese JSON es la fuente de
 * la verdad: al hidratar, el front lo lee primero y PISA IndexedDB con él
 * (`checkout-orders.ts`, "PRIORITY 1 / IndexedDB overwritten with backup data").
 * La config vive en `Documents\TitanioPOS-Settings\`. El nivel 3 sí cierra la
 * sesión y se lleva los presupuestos guardados (localStorage), por eso va de
 * último y la pantalla lo avisa antes de que alguien lo toque.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/** El front lo emite por consola apenas monta (ver `app-providers.tsx`). */
const READY_SIGNAL = 'TITANIO_APP_READY';

/** Generoso a propósito: en una caja lenta con Defender escaneando, el primer
 *  pintado tarda. La señal es "React montó", no "terminó de cargar datos". */
const TIMEOUT_MS = 45000;

const MAX_LEVEL = 3;


/** JS que el motor no puede ni parsear: bytes en cero, un chunk servido como
 *  HTML, o code cache podrido. No hace falta esperar el timeout.
 *  Se excluye a propósito el `SyntaxError` genérico: un `JSON.parse` fallido
 *  y capturado por la app lo imprime, y eso no es un arranque roto. */
const FATAL_PATTERNS = [
  /Invalid or unexpected token/i,
  /Unexpected token '</i,
  /Failed to load module script/i,
];

/** Cuántos errores fatales hacen falta para dar el arranque por perdido. Un
 *  error suelto puede ser una respuesta HTML donde se esperaba JSON; un bundle
 *  ilegible escupe uno por chunk (en el caso real fueron 34). */
const FATAL_THRESHOLD = 3;

/** Etiqueta del botón por nivel. La pantalla no explica nada más: el detalle
 *  técnico va al log. */
const LEVEL_INFO = {
  1: { label: 'Reparar' },
  2: { label: 'Reparar' },
  3: { label: 'Reparar' },
};

let timer = null;
let armedFor = null;    // URL vigilada (null = desarmado)
let lastAppUrl = null;  // última URL real de la app (para recargar tras reparar)
let repairing = false;
let logFile = null;
let fatalHits = 0;
let present = null;     // (info) => void — la pone main.js, que sabe dibujar

function log(msg) {
  const line = `[${new Date().toISOString()}] [WATCHDOG] ${msg}`;
  console.log(line);
  try {
    if (!logFile) logFile = path.join(app.getPath('userData'), 'frontend-local.log');
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {}
}

function healFile() { return path.join(app.getPath('userData'), 'boot-heal.json'); }

function readHeal() {
  try {
    const h = JSON.parse(fs.readFileSync(healFile(), 'utf8'));
    // Una versión nueva de la app es un escenario distinto: se empieza de cero.
    if (h.version !== app.getVersion()) return { level: 0 };
    return { level: parseInt(h.level, 10) || 0, at: h.at };
  } catch { return { level: 0 }; }
}

function writeHeal(level) {
  try {
    fs.writeFileSync(healFile(), JSON.stringify({
      level, at: new Date().toISOString(), version: app.getVersion(),
    }));
  } catch (_) {}
}

/** Deja la vista descargada fuera de juego: al relanzar se sirve la HORNEADA,
 *  que viene dentro del app.asar y no la toca ningún apagón. No borra los
 *  directorios a propósito — en Windows pueden estar con lock y el rename
 *  fallaría; con el puntero en null alcanza. */
function discardDownloadedView() {
  const state = path.join(app.getPath('userData'), 'views', 'state.json');
  try {
    if (!fs.existsSync(state)) return false;
    const prev = JSON.parse(fs.readFileSync(state, 'utf8'));
    if (!prev.active && !prev.next) return false;
    fs.writeFileSync(state, JSON.stringify({ active: null, next: null, skip: prev.skip || null }));
    log(`vista descargada descartada (era active=${prev.active}, next=${prev.next}) → se sirve la horneada`);
    return true;
  } catch (e) {
    log(`no se pudo descartar la vista: ${e && e.message}`);
    return false;
  }
}

function relaunch(why) {
  log(`relanzando la app (${why})`);
  try { app.relaunch(); } catch (_) {}
  try { app.exit(0); } catch (_) { app.quit(); }
}

/** Nivel que le toca al PRÓXIMO botón (0 si ya se agotaron). */
function nextLevel() {
  const n = readHeal().level + 1;
  return n > MAX_LEVEL ? 0 : n;
}

/** Muestra la pantalla de error. No repara nada. */
function showFailure(win, why) {
  if (repairing || !armedFor) return;
  disarm(`arranque fallido: ${why}`);
  const level = nextLevel();
  log(level
    ? `la UI no arrancó (${why}) → pantalla de reparación, siguiente nivel ${level}/${MAX_LEVEL}`
    : `la UI no arrancó (${why}) y la reparación ya se agotó (nivel ${MAX_LEVEL}); hay que revisar la caja a mano`);
  if (!present || !win || win.isDestroyed()) return;
  try { present({ why, level, info: level ? LEVEL_INFO[level] : null, maxLevel: MAX_LEVEL }); }
  catch (e) { log(`no se pudo mostrar la pantalla de reparación: ${e && e.message}`); }
}

/** Ejecuta la reparación del nivel que toca. La dispara EL BOTÓN, nunca sola. */
async function repairNow(win) {
  if (repairing) return;
  const level = nextLevel();
  if (!level) { log('botón de reparar pulsado sin niveles disponibles: no se hace nada'); return; }
  repairing = true;
  writeHeal(level);
  const ses = win.webContents.session;
  try {
    if (level === 1) {
      log('nivel 1: limpiando Code Cache, caché HTTP y service workers');
      // CON await, al contrario de la limpieza histórica de createWindow(): si no
      // se espera, corre carrera con la recarga y puede no haber servido de nada.
      await ses.clearCodeCaches({ urls: [] }).catch((e) => log(`clearCodeCaches: ${e && e.message}`));
      await ses.clearCache().catch((e) => log(`clearCache: ${e && e.message}`));
      await ses.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
        .catch((e) => log(`clearStorageData: ${e && e.message}`));
      log('nivel 1 aplicado → recargando la app');
      if (!win.isDestroyed() && lastAppUrl) {
        win.loadURL(lastAppUrl);
        arm(win, lastAppUrl);
      }
      return;
    }
    if (level === 2) {
      log('nivel 2: descartando la vista descargada');
      discardDownloadedView();
      relaunch('nivel 2');
      return;
    }
    log('nivel 3: limpiando el perfil completo (último recurso)');
    await ses.clearStorageData().catch((e) => log(`clearStorageData: ${e && e.message}`));
    await ses.clearCache().catch((e) => log(`clearCache: ${e && e.message}`));
    await ses.clearCodeCaches({ urls: [] }).catch((e) => log(`clearCodeCaches: ${e && e.message}`));
    relaunch('nivel 3');
  } catch (e) {
    log(`la reparación de nivel ${level} falló: ${e && e.message}`);
  } finally {
    repairing = false;
  }
}

/** main.js registra acá cómo dibujar la pantalla (evita el require circular). */
function setPresenter(fn) { present = typeof fn === 'function' ? fn : null; }

/** Empieza a vigilar la carga de `url`. Llamar justo después de `loadURL`. */
function arm(win, url) {
  disarm('re-armando');
  if (!win || win.isDestroyed()) return;
  armedFor = url;
  lastAppUrl = url;
  fatalHits = 0;
  const prev = readHeal().level;
  if (prev > 0) log(`arranque vigilado tras una reparación previa (nivel ${prev})`);
  timer = setTimeout(() => {
    showFailure(win, `sin ${READY_SIGNAL} en ${Math.round(TIMEOUT_MS / 1000)}s`);
  }, TIMEOUT_MS);
}

/** Deja de vigilar (pantallas de estado, error de red, cierre de ventana…). */
function disarm(reason) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (armedFor && reason) log(`vigilancia desactivada (${reason})`);
  armedFor = null;
}

/** La UI arrancó: se desarma y se borra el historial de reparaciones. */
function noteReady() {
  if (!armedFor && readHeal().level === 0) return;
  disarm(null);
  if (readHeal().level > 0) log('la UI arrancó bien → historial de reparación reseteado');
  writeHeal(0);
}

/** Mensajes de consola del renderer: la señal de vida y los errores fatales. */
function onConsoleMessage(win, message) {
  if (typeof message !== 'string' || !message) return;
  if (message.includes(READY_SIGNAL)) return noteReady();
  if (!armedFor) return;
  if (!FATAL_PATTERNS.some((re) => re.test(message))) return;
  fatalHits += 1;
  log(`error fatal ${fatalHits}/${FATAL_THRESHOLD}: ${message.slice(0, 140)}`);
  if (fatalHits >= FATAL_THRESHOLD) {
    showFailure(win, `${fatalHits} errores de JS ilegible en consola`);
  }
}

module.exports = {
  arm, disarm, noteReady, onConsoleMessage, repairNow, setPresenter,
  nextLevel, READY_SIGNAL, MAX_LEVEL, LEVEL_INFO,
};
