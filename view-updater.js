/**
 * view-updater.js — "Electron descarga la vista" (hot-swap del frontend SIN
 * reinstalar la app), con ALMACENAMIENTO VERSIONADO.
 *
 * MODELO (robusto, no toca la app andando, conserva varias builds):
 *   - Cada build descargada vive en  <userData>/views/<buildNumber>/  (server.js
 *     en la raíz). Se conservan las últimas N (por defecto 3) → permite ROLLBACK
 *     y SWITCH a demanda.
 *   - Un puntero  <userData>/views/state.json = { active, next }:
 *       active = build que corre AHORA;  next = build a aplicar en el próximo
 *       arranque (una descarga nueva o un switch manual).
 *   - Si no hay build activa válida → se usa la HORNEADA (extraResources), ver
 *     resolveServerDir() en el manager.
 *   - En BACKGROUND, con la app ya abierta: lee <UPDATE_URL>/latest.json, compara
 *     buildNumber. Si hay una nueva → baja el .zip de `url`, valida sha256+size,
 *     extrae, aplica el parche de Windows, la guarda en views/<n>/ y marca
 *     next=<n>. Prune de las viejas.
 *   - En el PRÓXIMO arranque, ANTES de levantar Next: si next está seteada y es
 *     válida, active=next. Nunca se toca la build en uso → sin reinicio en
 *     caliente, sin pelear con locks de Windows.
 *   - SWITCH a demanda: switchToBuild(n) setea next=n (debe estar instalada);
 *     se aplica al relanzar la app.
 *
 * Formato real de latest.json (prod):
 *   { version, buildNumber, sha256, size, url, releasedAt }
 *   - buildNumber: entero monótono (nº de commits).
 *   - url: absoluta al .zip (https://updates.titanio-pos.com/bundles/bundle-<v>.zip).
 *
 * OJO: el bundle del CI viene SIN el parche de Windows (server.js stock) → se le
 * aplica patchServerJsForWindows tras extraer.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const DEFAULT_UPDATE_URL = 'https://updates.titanio-pos.com';
const KEEP_BUILDS = 3; // cuántas builds descargadas conservar (rollback/switch)

function viewsRoot() { return path.join(app.getPath('userData'), 'views'); }
function buildDir(n) { return path.join(viewsRoot(), String(n)); }
function stateFile() { return path.join(viewsRoot(), 'state.json'); }

// Una build de la vista es válida si es standalone (server.js, legacy) o un
// export estático (index.html, sin servidor Node). Ambas conviven: rollback a
// builds viejas standalone sigue funcionando.
function hasServer(dir) {
  try {
    return fs.existsSync(path.join(dir, 'server.js')) || fs.existsSync(path.join(dir, 'index.html'));
  } catch { return false; }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function readState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    return {
      active: parseInt(s.active, 10) || null,
      next: parseInt(s.next, 10) || null,
      // skip: build DESCARTADA por un rollback manual; el check no la re-stagea
      // (si no, el auto-reinicio de 5 min desharía el rollback). Se limpia sola
      // cuando sale una build más nueva.
      skip: parseInt(s.skip, 10) || null,
    };
  } catch { return { active: null, next: null, skip: null }; }
}
function writeState(st) {
  try {
    fs.mkdirSync(viewsRoot(), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify({
      active: st.active || null,
      next: st.next || null,
      skip: st.skip || null,
    }));
  } catch (_) {}
}

/** Builds descargadas y válidas (con server.js), de mayor a menor. */
function listBuilds() {
  try {
    return fs.readdirSync(viewsRoot())
      .map((n) => parseInt(n, 10))
      .filter((n) => Number.isInteger(n) && hasServer(buildDir(n)))
      .sort((a, b) => b - a);
  } catch { return []; }
}

/** Dir de la vista HORNEADA. Vive DENTRO del app.asar (un solo archivo en vez
 *  de ~2.200: el instalador NSIS extrae miles de archivos con Defender
 *  escaneando cada uno — la vista suelta duplicaba el tiempo de instalación).
 *  fs de Electron lee dentro del asar de forma transparente en el main.
 *  app.getAppPath() = <resources>/app.asar en packaged, el repo en dev. */
function bakedServerDir() {
  const override = (process.env.TITANIOPOS_FRONTEND_SERVER_DIR || '').trim();
  if (override) return override;
  return path.join(app.getAppPath(), 'frontend-server');
}

/** buildNumber intrínseco de un server dir vía view-version.json (0 si no hay).
 *  Lo escriben checkAndStageUpdate (bundles descargados) y bundle-frontend.js
 *  (horneada). Es la red de seguridad cuando state.json se pierde/invalida. */
function readBuildNumberOf(dir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dir, 'view-version.json'), 'utf8'));
    return parseInt(v.buildNumber, 10) || 0;
  } catch { return 0; }
}

// Dir que el manager está SIRVIENDO en esta sesión (lo setea al forkear Next).
// Sin esto, si state.json se pierde con la app abierta, el updater cree que
// corre la horneada y re-stagea la build que ya está corriendo.
let runningServerDir = null;
function noteRunningServerDir(dir) { runningServerDir = dir || null; }

/** buildNumber de la build ACTIVA (0 si ninguna → se usa la horneada). */
function getActiveBuildNumber() {
  const { active } = readState();
  const baked = readBuildNumberOf(bakedServerDir());
  // Si la horneada es MÁS NUEVA que la descargada activa (shell recién
  // actualizado con una vista más reciente adentro), manda la horneada: si no,
  // la caja serviría la vieja y offline se quedaría ahí para siempre.
  if (active && hasServer(buildDir(active)) && active >= baked) return active;
  return baked;
}

/** buildNumber de lo que se está SIRVIENDO ahora (identidad intrínseca). */
function getRunningBuildNumber() {
  if (runningServerDir) {
    const n = readBuildNumberOf(runningServerDir);
    if (n) return n;
  }
  return getActiveBuildNumber();
}
/** Carpeta de la build activa si es válida Y no la supera la horneada; si no,
 *  null (→ horneada). */
function activeServerDir() {
  const { active } = readState();
  if (!active || !hasServer(buildDir(active))) return null;
  if (readBuildNumberOf(bakedServerDir()) > active) return null; // horneada más nueva
  return buildDir(active);
}

/**
 * Aplica la build PENDIENTE (state.next) como activa. Llamar al ARRANCAR, ANTES
 * de levantar Next (la build activa no está en uso → sin locks). No-op si no hay
 * next válida.
 * @returns {boolean} true si cambió la activa.
 */
function applyPendingView(log = () => {}) {
  const st = readState();
  if (!st.next) return false;
  if (!hasServer(buildDir(st.next))) { writeState({ active: st.active, next: null, skip: st.skip }); return false; }
  if (st.next === st.active) { writeState({ active: st.active, next: null, skip: st.skip }); return false; }
  writeState({ active: st.next, next: null, skip: st.skip });
  log(`[VIEW] build ${st.next} aplicada en este arranque (antes: ${st.active || 'horneada'})`);
  return true;
}

/** Conserva las KEEP_BUILDS más nuevas + la activa + la pendiente + la que se
 *  está SIRVIENDO; borra el resto. */
function pruneOldBuilds(log = () => {}) {
  const st = readState();
  const protect = new Set([st.active, st.next].filter(Boolean));
  // La build servida en esta sesión se protege POR DIRECTORIO aunque state.json
  // esté perdido/desfasado: borrarla en vivo = 404 en toda la UI hasta reiniciar.
  if (runningServerDir) {
    const runningN = parseInt(path.basename(runningServerDir), 10);
    if (Number.isInteger(runningN)) protect.add(runningN);
  }
  const builds = listBuilds();
  const keep = new Set(builds.slice(0, KEEP_BUILDS));
  for (const n of builds) {
    if (keep.has(n) || protect.has(n)) continue;
    rmrf(buildDir(n));
    log(`[VIEW] build ${n} eliminada (prune, conservo ${KEEP_BUILDS})`);
  }
  // Staging interrumpido: directorios <n>.tmp huérfanos de una copia a medias.
  try {
    for (const d of fs.readdirSync(viewsRoot())) {
      if (d.endsWith('.tmp')) rmrf(path.join(viewsRoot(), d));
    }
  } catch (_) {}
}

/**
 * Switch a demanda a una build YA descargada. Setea next=n; se aplica al
 * relanzar la app (el caller decide relanzar).
 * @returns {{ok:boolean, reason?:string}}
 */
function switchToBuild(n, log = () => {}) {
  const target = parseInt(n, 10);
  if (!target || !hasServer(buildDir(target))) return { ok: false, reason: `build ${n} no instalada` };
  const st = readState();
  // Rollback manual (target menor que lo que se abandona): descartar la build
  // mayor. Sin esto, el check periódico la re-stagea y el auto-reinicio de
  // 5 min deshace el rollback — la build rota volvería sola en ~6 minutos.
  const abandoned = Math.max(st.active || 0, st.next || 0, getRunningBuildNumber() || 0);
  const skip = abandoned > target ? abandoned : null;
  writeState({ active: st.active, next: target, skip });
  log(`[VIEW] switch programado a build ${target} (se aplica al relanzar)` +
    (skip ? ` — build ${skip} descartada hasta que salga una más nueva` : ''));
  return { ok: true };
}

// OJO en ambas funciones HTTP: el `timeout` de Node es de INACTIVIDAD del
// socket, no total. Sin `res.on('error')` una respuesta truncada colgaba la
// promesa para siempre → el guard `viewCheckRunning` quedaba tomado y la caja
// no volvía a chequear updates hasta reiniciar la app.
function fetchText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.get(u, { timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 400) { res.resume(); return done(reject, new Error('HTTP ' + res.statusCode)); }
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => done(resolve, data));
        res.on('error', (e) => done(reject, e));
        res.on('aborted', () => done(reject, new Error('respuesta abortada')));
      });
      req.on('error', (e) => done(reject, e));
      req.on('timeout', () => { req.destroy(); done(reject, new Error('timeout')); });
    } catch (e) { done(reject, e); }
  });
}

/**
 * Descarga a archivo calculando sha256 EN STREAMING (evita releer el zip
 * completo a RAM en los Celeron). Resuelve { sha256 }. `timeoutMs` es de
 * inactividad; `deadlineMs` corta descargas que gotean indefinidamente.
 */
function downloadToFile(url, destPath, timeoutMs = 180000, onProgress = null, deadlineMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    const file = fs.createWriteStream(destPath);
    const hash = crypto.createHash('sha256');
    const deadline = setTimeout(() => fail(new Error('deadline de descarga excedido')), deadlineMs);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { req && req.destroy(); } catch (_) {}
      // Cerrar el WriteStream ANTES de borrar: en Windows un archivo abierto
      // no se puede borrar y el temp quedaba acumulándose por cada fallo.
      file.close(() => { try { fs.unlinkSync(destPath); } catch (_) {} });
      reject(e);
    };
    try {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      req = mod.get(u, { timeout: timeoutMs }, (res) => {
        if (res.statusCode && res.statusCode >= 400) { res.resume(); return fail(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          hash.update(c);
          if (onProgress) { try { onProgress(got, total); } catch (_) {} }
        });
        res.on('error', (e) => fail(e));
        res.on('aborted', () => fail(new Error('descarga abortada')));
        res.pipe(file);
        file.on('finish', () => file.close(() => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolve({ sha256: hash.digest('hex') });
        }));
      });
      req.on('error', (e) => fail(e));
      req.on('timeout', () => fail(new Error('timeout (socket inactivo)')));
      file.on('error', (e) => fail(e));
    } catch (e) { fail(e); }
  });
}

/** Extrae un .zip a targetDir. Win10+/macOS: bsdtar (`tar -xf`). Linux: unzip. */
function extractZip(zipPath, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  try { execFileSync('tar', ['-xf', zipPath, '-C', targetDir], { stdio: 'ignore' }); return; }
  catch (_) { /* sin bsdtar → fallback por plataforma */ }
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${targetDir}" -Force`], { stdio: 'ignore' });
  } else {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', targetDir], { stdio: 'ignore' });
  }
}

/**
 * Parche de Windows: el standalone de Next falla con MODULE_NOT_FOUND al
 * require() de rutas con [ ] ( ) ([store], grupos (auth)) en Windows aunque el
 * archivo exista. Inyecta en server.js un shim de Module._resolveFilename que
 * SOLO recupera requests de RUTA cuyo archivo existe (nunca paquetes). Idéntico
 * a patchServerShimForWindows de bundle-frontend.js. Idempotente (marcador).
 */
function patchServerJsForWindows(serverDir) {
  const serverJs = path.join(serverDir, 'server.js');
  const MARKER = '/* titaniopos-win-resolve-shim */';
  let src;
  try { src = fs.readFileSync(serverJs, 'utf8'); } catch { return; }
  if (src.includes(MARKER)) return;
  const shim = `${MARKER}
(() => {
  const Module = require('module');
  const path = require('path');
  const fs = require('fs');
  const orig = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    try {
      return orig.call(this, request, parent, isMain, options);
    } catch (err) {
      if (err && err.code === 'MODULE_NOT_FOUND' && typeof request === 'string'
          && (request[0] === '.' || path.isAbsolute(request))) {
        const base = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
        const abs = path.resolve(base, request);
        const cands = [abs, abs + '.js', abs + '.json', abs + '.node',
                       path.join(abs, 'index.js'), path.join(abs, 'index.json')];
        for (const c of cands) {
          try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch (_) {}
        }
      }
      throw err;
    }
  };
})();
`;
  fs.writeFileSync(serverJs, shim + src);
}

/**
 * Chequea latest.json y, si hay build nueva (y no instalada), la baja + valida +
 * extrae + parchea, la guarda en views/<n>/ y marca next=<n> (se aplica al
 * próximo arranque). Prune de las viejas. NO toca la build en uso. Llamar en
 * BACKGROUND con la app ya abierta.
 * `notify(evento, data)` (opcional) informa el avance para UI: 'downloading'
 * {buildNumber,size}, 'progress' {buildNumber,got,total}, 'staged'
 * {buildNumber}, 'error' {message}. Nunca lanza (se traga errores del caller).
 * @returns {Promise<{staged:boolean, buildNumber?:number, reason?:string}>}
 */
async function checkAndStageUpdate(updateUrl, log = () => {}, notify = null) {
  const emit = (ev, data) => { try { if (notify) notify(ev, data); } catch (_) {} };
  const base = String(updateUrl || DEFAULT_UPDATE_URL).replace(/\/$/, '');

  let meta;
  try { meta = JSON.parse(await fetchText(base + '/latest.json')); }
  catch (e) { log(`[VIEW] sin latest.json (${e && e.message}) → uso la vista actual`); return { staged: false, reason: 'offline/sin latest.json' }; }

  const remote = parseInt(meta.buildNumber, 10) || 0;
  const active = getActiveBuildNumber();
  // Comparar también contra lo que se está SIRVIENDO: si state.json se perdió
  // (reset manual, antivirus, userData distinto), `active` miente (0/horneada)
  // y sin este guard se re-descarga y re-stagea la build que YA corre → prompt
  // de reinicio espurio en loop.
  const running = getRunningBuildNumber();
  const current = Math.max(active, running);
  log(`[VIEW] activa=${active} corriendo=${running} remota=${remote} instaladas=[${listBuilds().join(',')}]`);
  if (remote <= current) return { staged: false, reason: 'al día' };
  const st0 = readState();
  // Build descartada por rollback manual: no re-instalarla. Se reanuda solo
  // cuando la remota AVANZA más allá de la descartada.
  if (st0.skip && remote === st0.skip) {
    return { staged: false, buildNumber: remote, reason: 'descartada por rollback' };
  }
  if (st0.skip && remote > st0.skip) {
    writeState({ active: st0.active, next: st0.next, skip: null });
    log(`[VIEW] build ${st0.skip} descartada quedó atrás (remota=${remote}); se reanuda la actualización`);
  }
  // Ya está marcada como pendiente: NO re-stagear ni re-emitir 'staged' — el
  // chequeo periódico reseteaba el timer de auto-reinicio a 5:00 cada vez y el
  // reinicio no llegaba nunca.
  if (st0.next === remote) {
    return { staged: false, buildNumber: remote, reason: 'descargada, pendiente de reinicio' };
  }
  if (hasServer(buildDir(remote))) {
    // Ya descargada (de antes): solo marcarla como pendiente.
    switchToBuild(remote, log);
    emit('staged', { buildNumber: remote });
    return { staged: true, buildNumber: remote, reason: 'ya estaba descargada' };
  }
  if (!meta.url) return { staged: false, reason: 'latest.json sin url' };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tpos-view-'));
  const zipPath = path.join(tmp, 'bundle.zip');
  const stage = path.join(tmp, 'stage');
  try {
    // Espacio en disco: pico de ~3× el bundle (zip + extraído + copia). Fallar
    // ANTES de descargar evita la copia parcial en disco lleno.
    const needBytes = 3 * (parseInt(meta.size, 10) || 50 * 1024 * 1024);
    try {
      const sfs = fs.statfsSync(app.getPath('userData'));
      if (sfs.bavail * sfs.bsize < needBytes) {
        throw new Error(`espacio en disco insuficiente (necesita ~${Math.round(needBytes / 1e6)} MB libres)`);
      }
    } catch (e) {
      if (String(e && e.message).includes('espacio en disco')) throw e;
      /* statfs no disponible → seguir */
    }

    log(`[VIEW] descargando build ${remote}: ${meta.url}`);
    emit('downloading', { buildNumber: remote, size: parseInt(meta.size, 10) || 0 });
    const dl = await downloadToFile(meta.url, zipPath, 180000, (got, total) =>
      emit('progress', { buildNumber: remote, got, total }));

    if (meta.size) {
      const got = fs.statSync(zipPath).size;
      if (got !== parseInt(meta.size, 10)) throw new Error(`size no coincide (esperado ${meta.size}, got ${got})`);
    }
    if (meta.sha256) {
      // Hash calculado en streaming durante la descarga (sin releer el zip).
      if (dl.sha256.toLowerCase() !== String(meta.sha256).toLowerCase()) throw new Error(`sha256 no coincide (esperado ${meta.sha256})`);
      log('[VIEW] sha256 + size OK');
    }

    extractZip(zipPath, stage);
    // El zip trae server.js (standalone legacy) o index.html (export estático)
    // en la raíz. Por las dudas, si viniera anidado, lo buscamos un nivel.
    let serverDir = stage;
    if (!hasServer(serverDir)) {
      const sub = fs.readdirSync(stage).map((n) => path.join(stage, n)).find((p) => hasServer(p));
      if (sub) serverDir = sub; else throw new Error('el zip no tiene server.js ni index.html');
    }

    // Solo aplica a bundles standalone (no-op si no hay server.js).
    patchServerJsForWindows(serverDir);

    // Staging ATÓMICO en dos saltos: primero a views/<n>.tmp (si esta copia
    // desde %TEMP% se corta, el .tmp nunca parece una build válida y el prune
    // lo limpia), y al final UN renameSync mismo-volumen a views/<n>. El
    // view-version.json se escribe como ÚLTIMO paso del .tmp: una copia a
    // medias jamás queda activable.
    fs.mkdirSync(viewsRoot(), { recursive: true });
    const dest = buildDir(remote);
    const destTmp = dest + '.tmp';
    // Jamás borrar el directorio que Next está sirviendo en vivo (posible si el
    // estado se leyó mal): borrado parcial con locks de Windows = build corrupta.
    if (runningServerDir && path.resolve(dest) === path.resolve(runningServerDir)) {
      throw new Error(`views/${remote} es la build en uso; no se pisa en caliente`);
    }
    rmrf(destTmp);
    try { fs.renameSync(serverDir, destTmp); }
    catch (_) { fs.cpSync(serverDir, destTmp, { recursive: true }); }
    fs.writeFileSync(path.join(destTmp, 'view-version.json'), JSON.stringify({ buildNumber: remote, version: meta.version || String(remote) }));
    rmrf(dest);
    fs.renameSync(destTmp, dest);

    const st = readState();
    writeState({ active: st.active, next: remote, skip: st.skip });
    pruneOldBuilds(log);

    log(`[VIEW] build ${remote} lista → se aplica en el próximo arranque. instaladas=[${listBuilds().join(',')}]`);
    emit('staged', { buildNumber: remote });
    return { staged: true, buildNumber: remote };
  } catch (e) {
    log(`[VIEW] error preparando update (${e && e.message}) → conservo la vista actual`);
    emit('error', { message: e && e.message });
    return { staged: false, reason: e && e.message };
  } finally {
    rmrf(tmp);
  }
}

module.exports = {
  checkAndStageUpdate,
  applyPendingView,
  activeServerDir,
  getActiveBuildNumber,
  getRunningBuildNumber,
  noteRunningServerDir,
  listBuilds,
  switchToBuild,
  pruneOldBuilds,
  readState,
  DEFAULT_UPDATE_URL,
  KEEP_BUILDS,
};
