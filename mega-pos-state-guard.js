/**
 * Guardia del estado del VPOS (Megasoft) por terminal + carpeta de resultados.
 *
 * Dos averías que dejaban la caja sin Mega POS hasta que alguien entrara a
 * mano, y que el servicio no se cura solo:
 *
 * 1. `EB - FALTA ARCHIVO DE CONFIGURACION (SEQNUM)`: el VPOS guarda el
 *    consecutivo real del terminal (`seqnumber`) y los advices pendientes en
 *    `conf/<VTID>/<VTID>.ini` de la copia runtime. Un corte de luz o un cierre
 *    brusco mientras lo escribe lo deja en 0 bytes o truncado; su propia copia
 *    `<VTID>.ini_copia` no sirve porque la pisa en cada arranque con lo que
 *    encuentre (dañado incluido). Aquí se guarda un respaldo PROPIO cada vez
 *    que el archivo cambia con contenido sano, fuera del runtime (la recopia
 *    de la distro borra el runtime entero), y al arrancar el servicio se
 *    restaura si el archivo está roto.
 *
 * 2. `99 - Error al intentar accesar configuracion o instanciar modulo Vpos
 *    (LA)`: `LA` es "ERROR CONFIGURANDO RUTA DE RESULTADOS (PATH)" en el
 *    vposerror.ini de Megasoft. El VPOS escribe vouchers y archivos de control
 *    en `[path] path=` del vposconf.ini (C:\voucher\). Si la carpeta no existe
 *    o no se puede escribir, el módulo no instancia. Antes de arrancar se crea
 *    y se prueba una escritura.
 *
 * 3. El mismo `99 ... (LA)` con la carpeta intacta: `conf/vposconf.ini` de la
 *    copia runtime relleno de bytes nulos. Es lo que deja NTFS cuando se va la
 *    luz con el archivo recién escrito (el tamaño queda, el contenido no), y
 *    tanto la app como el propio VPOS lo reescriben en cada arranque. El VPOS
 *    no encuentra `[path]` y aborta ("Constructor LA"); ningún reinicio lo
 *    cura porque la app solo reescribe las secciones que encuentra. Visto en
 *    producción en Guacara caja 3 (2026-11-10), Turén caja 3 y Mariara caja 4
 *    (2026-11-13); reponer el archivo desde la distribución empaquetada lo
 *    arregla en el acto. Aquí se detecta (nulos, vacío o sin sus secciones) y
 *    se repone antes de aplicar la config de la caja, y las escrituras de la
 *    app pasan a ser atómicas y solo cuando el contenido cambia.
 *
 * Todo es best-effort: nada de aquí lanza ni impide arrancar el VPOS. Lo que
 * falle queda en el log y en el estado que lee el chequeo de caja.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_SUFFIX = '.state-snapshots';
const HISTORY_KEEP = 5;
const DEFAULT_VOUCHER_BASE = 'C:\\voucher';
const DEFAULT_TIMER_DIR = 'C:\\timer';
const VOUCHER_SUBDIRS = ['vouchers', 'archivosControl'];
const DAMAGED_KEEP = 3;

/**
 * Archivos de `conf/` que el VPOS necesita para instanciar, con las secciones
 * que deben estar. Cualquier otro archivo de `conf/` que venga en la distro se
 * revisa solo por "vacío o con bytes nulos".
 */
const CONFIG_REQUIRED_SECTIONS = {
  'vposconf.ini': ['server', 'vtid', 'path', 'SeqNum'],
  'vposuniversal.ini': ['COMPRA_MEDIOS_PAGO'],
};

const noop = () => {};

// ─── Estado por terminal ────────────────────────────────────────────────────

const vtidStatePath = (runtime, vtid) => path.join(runtime, 'conf', vtid, `${vtid}.ini`);
const snapshotRoot = (runtime) => `${runtime}${SNAPSHOT_SUFFIX}`;
const snapshotFile = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, `${vtid}.ini`);
const snapshotMeta = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, `${vtid}.json`);
const snapshotHistoryDir = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, 'history');

/**
 * Lee lo que importa del `<VTID>.ini`: que exista la sección del terminal y
 * la clave `seqnumber` (vacía en un terminal que nunca transaccionó; con
 * dígitos después del primer logon).
 */
const parseState = (text, vtid) => {
  const lines = String(text || '').split(/\r?\n/);
  let section = null;
  let hasSection = false;
  let hasSeqKey = false;
  let seqnumber = null;
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1].trim();
      if (section.toLowerCase() === String(vtid).toLowerCase()) hasSection = true;
      continue;
    }
    if (section && section.toLowerCase() === String(vtid).toLowerCase()) {
      const kv = line.match(/^\s*seqnumber\s*=\s*(.*)$/i);
      if (kv) { hasSeqKey = true; seqnumber = kv[1].trim(); }
    }
  }
  return { hasSection, hasSeqKey, seqnumber };
};

/**
 * Diagnóstico del archivo de estado: sano = existe, tiene bytes, tiene la
 * sección del terminal y la clave `seqnumber`. `reason` dice qué falta.
 */
const inspectStateFile = (runtime, vtid) => {
  const file = vtidStatePath(runtime, vtid);
  const out = { path: file, exists: false, size: 0, hasSection: false, hasSeqKey: false, seqnumber: null, healthy: false, reason: 'missing', mtime: null };
  if (!vtid) return { ...out, reason: 'no-vtid' };
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return out; }
  out.exists = true;
  out.size = stat.size;
  out.mtime = stat.mtimeMs;
  if (!stat.size) return { ...out, reason: 'empty' };
  let text = '';
  try { text = fs.readFileSync(file, 'latin1'); } catch (e) { return { ...out, reason: `unreadable: ${e.message}` }; }
  const parsed = parseState(text, vtid);
  Object.assign(out, parsed);
  if (!parsed.hasSection) return { ...out, reason: 'no-section' };
  if (!parsed.hasSeqKey) return { ...out, reason: 'no-seqnumber' };
  return { ...out, healthy: true, reason: null };
};

/** Solo vale la pena respaldar un estado con consecutivo real (dígitos). */
const isSnapshotWorthy = (state) => Boolean(state && state.healthy && /^\d+$/.test(String(state.seqnumber || '')));

const readSnapshot = (runtime, vtid) => {
  const file = snapshotFile(runtime, vtid);
  const out = { path: file, exists: false, content: null, at: null, seqnumber: null };
  if (!vtid) return out;
  try {
    out.content = fs.readFileSync(file, 'latin1');
    out.exists = out.content.length > 0;
  } catch (_) { return out; }
  try {
    const meta = JSON.parse(fs.readFileSync(snapshotMeta(runtime, vtid), 'utf8'));
    out.at = meta.at || null;
    out.seqnumber = meta.seqnumber ?? null;
  } catch (_) {
    out.seqnumber = parseState(out.content, vtid).seqnumber;
  }
  return out;
};

const writeFileAtomic = (file, content) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'latin1');
  fs.renameSync(tmp, file);
};

/**
 * Guarda el estado actual como respaldo si es sano y cambió respecto al
 * respaldo anterior (el anterior pasa a `history/`, se conservan HISTORY_KEEP).
 * @returns {{saved: boolean, reason?: string, seqnumber?: string|null}}
 */
const snapshotState = (runtime, vtid, log = noop) => {
  const state = inspectStateFile(runtime, vtid);
  if (!isSnapshotWorthy(state)) return { saved: false, reason: state.reason || 'no-seqnumber-digits', seqnumber: state.seqnumber };
  let content;
  try { content = fs.readFileSync(state.path, 'latin1'); } catch (e) { return { saved: false, reason: e.message }; }
  const prev = readSnapshot(runtime, vtid);
  if (prev.exists && prev.content === content) return { saved: false, reason: 'unchanged', seqnumber: state.seqnumber };
  try {
    const dir = path.dirname(snapshotFile(runtime, vtid));
    fs.mkdirSync(dir, { recursive: true });
    if (prev.exists) {
      const hist = snapshotHistoryDir(runtime, vtid);
      fs.mkdirSync(hist, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(hist, `${stamp}.ini`), prev.content, 'latin1');
      const old = fs.readdirSync(hist).filter((n) => n.endsWith('.ini')).sort();
      for (const n of old.slice(0, Math.max(0, old.length - HISTORY_KEEP))) {
        try { fs.unlinkSync(path.join(hist, n)); } catch (_) {}
      }
    }
    writeFileAtomic(snapshotFile(runtime, vtid), content);
    fs.writeFileSync(snapshotMeta(runtime, vtid), JSON.stringify({ at: new Date().toISOString(), seqnumber: state.seqnumber, size: state.size }), 'utf8');
    log(`[MEGA_POS][estado] respaldo de ${vtid} guardado (seqnumber=${state.seqnumber})`);
    return { saved: true, seqnumber: state.seqnumber };
  } catch (e) {
    log(`[MEGA_POS][estado] no se pudo respaldar ${vtid}: ${e.message}`);
    return { saved: false, reason: e.message };
  }
};

/**
 * Restaura el último respaldo sobre `conf/<VTID>/<VTID>.ini`. El archivo
 * dañado (si existe) se conserva al lado como `.ini.damaged-<fecha>`.
 */
const restoreState = (runtime, vtid, log = noop) => {
  const snap = readSnapshot(runtime, vtid);
  if (!snap.exists) return { restored: false, reason: 'no-snapshot' };
  const target = vtidStatePath(runtime, vtid);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(target, `${target}.damaged-${stamp}`); } catch (_) { fs.rmSync(target, { force: true }); }
    }
    writeFileAtomic(target, snap.content);
    try {
      const meta = JSON.parse(fs.readFileSync(snapshotMeta(runtime, vtid), 'utf8'));
      meta.restoredAt = new Date().toISOString();
      fs.writeFileSync(snapshotMeta(runtime, vtid), JSON.stringify(meta), 'utf8');
    } catch (_) {}
    log(`[MEGA_POS][estado] ${vtid} restaurado desde el respaldo (seqnumber=${snap.seqnumber}, de ${snap.at || '?'})`);
    return { restored: true, seqnumber: snap.seqnumber, at: snap.at };
  } catch (e) {
    log(`[MEGA_POS][estado] no se pudo restaurar ${vtid}: ${e.message}`);
    return { restored: false, reason: e.message };
  }
};

/**
 * Antes de lanzar el Java: si el estado está sano se respalda; si está roto y
 * hay respaldo, se restaura; si está roto y no hay respaldo, se avisa (el VPOS
 * creará uno nuevo si puede — en un terminal que ya transaccionó eso termina
 * en EB o en "SeqNum ya existe", y hay que realinear con Megasoft).
 */
const guardStateOnStart = (runtime, vtid, log = noop) => {
  if (!vtid) return { action: 'none', state: null, snapshot: null };
  const state = inspectStateFile(runtime, vtid);
  if (state.healthy) {
    const snap = snapshotState(runtime, vtid, log);
    return { action: snap.saved ? 'snapshot' : 'none', state, snapshot: readSnapshot(runtime, vtid) };
  }
  const snap = readSnapshot(runtime, vtid);
  if (snap.exists) {
    const r = restoreState(runtime, vtid, log);
    return { action: r.restored ? 'restored' : 'restore-failed', state: inspectStateFile(runtime, vtid), snapshot: snap, error: r.reason };
  }
  if (state.exists) {
    log(`[MEGA_POS][estado] ${vtid} está dañado (${state.reason}) y no hay respaldo: se deja al VPOS.`);
  }
  return { action: state.exists ? 'unhealthy-no-backup' : 'fresh', state, snapshot: snap };
};

/**
 * Vigilancia por sondeo (fs.watch en Windows pierde escrituras del Java y se
 * desengancha si la carpeta se recrea): cada `intervalMs` compara mtime/size y
 * respalda si cambió. Devuelve { stop, poke } — `poke` fuerza una pasada (tras
 * cada transacción).
 */
const watchState = (runtime, vtid, log = noop, intervalMs = 15000) => {
  if (!vtid) return { stop: noop, poke: noop };
  let last = null;
  const pass = () => {
    try {
      const st = fs.statSync(vtidStatePath(runtime, vtid));
      const sig = `${st.size}:${st.mtimeMs}`;
      if (sig === last) return;
      last = sig;
      snapshotState(runtime, vtid, log);
    } catch (_) { /* aún no existe */ }
  };
  const timer = setInterval(pass, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  pass();
  return { stop: () => clearInterval(timer), poke: pass };
};

// ─── Archivos de configuración del VPOS (conf/*.ini) ────────────────────────

/**
 * Escritura segura de un archivo de config: no toca el disco si el contenido
 * no cambió (el arranque reescribía vposconf.ini dos veces cada vez, y cada
 * escritura es una ventana para que un corte de luz lo deje en ceros) y, si
 * cambió, escribe a un temporal, lo baja a disco (fsync) y lo renombra encima.
 * @returns {boolean} true si escribió.
 */
const writeFileSafe = (file, content, encoding = 'utf8') => {
  try {
    if (fs.readFileSync(file, encoding) === content) return false;
  } catch (_) { /* no existe o ilegible: se escribe */ }
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, encoding);
    try { fs.fsyncSync(fd); } catch (_) { /* FS sin fsync: se sigue */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return true;
};

/**
 * Diagnóstico de un archivo de config: sano = existe, tiene bytes, no tiene
 * bytes nulos y trae las secciones exigidas.
 */
const inspectConfigFile = (file, requiredSections = []) => {
  const out = { path: file, exists: false, size: 0, nulls: 0, missingSections: [], healthy: false, reason: 'missing' };
  let buf;
  try { buf = fs.readFileSync(file); } catch (_) { return out; }
  out.exists = true;
  out.size = buf.length;
  if (!buf.length) return { ...out, reason: 'empty' };
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0) out.nulls++;
  if (out.nulls) return { ...out, reason: 'nulls' };
  if (requiredSections.length) {
    const text = buf.toString('latin1');
    out.missingSections = requiredSections.filter(
      (s) => !new RegExp(`^\\s*\\[${s.replace(/[-[\]]/g, '\\$&')}\\]\\s*$`, 'im').test(text),
    );
    if (out.missingSections.length) return { ...out, reason: 'no-sections' };
  }
  return { ...out, healthy: true, reason: null };
};

/** Archivos regulares directamente en `conf/` de la distro (ini, xml, properties…). */
const listDistroConfFiles = (source) => {
  try {
    return fs.readdirSync(path.join(source, 'conf'), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch (_) { return []; }
};

const pruneDamaged = (dir, name) => {
  try {
    const old = fs.readdirSync(dir).filter((n) => n.startsWith(`${name}.corrupto-`)).sort();
    for (const n of old.slice(0, Math.max(0, old.length - DAMAGED_KEEP))) {
      try { fs.unlinkSync(path.join(dir, n)); } catch (_) {}
    }
  } catch (_) {}
};

/**
 * Repone desde la distribución empaquetada cada archivo de `conf/` que esté
 * dañado en la copia runtime. El dañado se conserva como `.corrupto-<fecha>`
 * (los últimos DAMAGED_KEEP). No toca subcarpetas (`conf/<VTID>/` es estado
 * del terminal, lo cuida guardStateOnStart). Tras reponer vposconf.ini la app
 * vuelve a aplicar servidor / VTID / pinpad como en cualquier arranque.
 * @returns {{ok: boolean, healed: {name: string, reason: string}[], failed: {name: string, reason: string, error: string}[]}}
 */
const healConfigFiles = (source, runtime, log = noop) => {
  const healed = [];
  const failed = [];
  const confDir = path.join(runtime, 'conf');
  for (const name of listDistroConfFiles(source)) {
    const file = path.join(confDir, name);
    const state = inspectConfigFile(file, CONFIG_REQUIRED_SECTIONS[name] || []);
    if (state.healthy) continue;
    const from = path.join(source, 'conf', name);
    // La distro es la referencia: si su copia tampoco pasa la revisión (una
    // versión futura sin esa sección, p. ej.), no se pisa nada.
    if (!inspectConfigFile(from, CONFIG_REQUIRED_SECTIONS[name] || []).healthy) continue;
    try {
      fs.mkdirSync(confDir, { recursive: true });
      if (state.exists) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try { fs.renameSync(file, `${file}.corrupto-${stamp}`); } catch (_) { fs.rmSync(file, { force: true }); }
        pruneDamaged(confDir, name);
      }
      const tmp = `${file}.tmp-${process.pid}`;
      fs.copyFileSync(from, tmp);
      fs.renameSync(tmp, file);
      healed.push({ name, reason: state.reason });
      log(`[MEGA_POS][config] ${name} estaba dañado (${state.reason}${state.nulls ? `, ${state.nulls} bytes nulos de ${state.size}` : ''}): repuesto desde la distribución`);
    } catch (e) {
      failed.push({ name, reason: state.reason, error: e.message });
      log(`[MEGA_POS][config] no se pudo reponer ${name} (${state.reason}): ${e.message}`);
    }
  }
  return { ok: failed.length === 0, healed, failed };
};

/** Solo diagnóstico de los archivos con secciones exigidas (para el chequeo de caja). */
const inspectConfigFiles = (runtime) =>
  Object.entries(CONFIG_REQUIRED_SECTIONS).map(([name, sections]) => {
    const s = inspectConfigFile(path.join(runtime, 'conf', name), sections);
    return { name, exists: s.exists, size: s.size, nulls: s.nulls, missingSections: s.missingSections, healthy: s.healthy, reason: s.reason };
  });

// ─── Carpeta de resultados (vouchers / archivos de control) ─────────────────

/** `[path] path=` del vposconf.ini runtime; si no, C:\voucher (o la variable de entorno). */
const resolveVoucherBase = (runtime) => {
  const env = process.env.TITANIOPOS_VPOS_VOUCHER_DIR;
  if (env) return env.replace(/[\\/]+$/, '');
  try {
    const ini = fs.readFileSync(path.join(runtime, 'conf', 'vposconf.ini'), 'latin1');
    const m = ini.match(/\[path\][^[]*?^\s*path\s*=\s*([^\r\n]+)/im);
    const p = m ? m[1].trim() : '';
    if (p) return p.replace(/[\\/]+$/, '');
  } catch (_) {}
  return DEFAULT_VOUCHER_BASE;
};

/** `[path] pathtimer=` del vposconf.ini runtime; si no, C:\\timer. El VPOS la exige igual que `path`. */
const resolveTimerDir = (runtime) => {
  try {
    const ini = fs.readFileSync(path.join(runtime, 'conf', 'vposconf.ini'), 'latin1');
    const m = ini.match(/\[path\][^[]*?^\s*pathtimer\s*=\s*([^\r\n]+)/im);
    const p = m ? m[1].trim() : '';
    if (p) return p.replace(/[\\/]+$/, '');
  } catch (_) {}
  return DEFAULT_TIMER_DIR;
};

const probeWritable = (dir) => {
  const probe = path.join(dir, `.titaniopos-write-${process.pid}`);
  fs.writeFileSync(probe, 'ok', 'utf8');
  fs.unlinkSync(probe);
};

/**
 * Crea la carpeta base y sus subcarpetas si faltan y prueba una escritura.
 * @returns {{ok: boolean, base: string, created: string[], error?: string}}
 */
const ensureVoucherDirs = (runtime, log = noop, baseOverride) => {
  const base = baseOverride || resolveVoucherBase(runtime);
  const created = [];
  try {
    for (const dir of [base, ...VOUCHER_SUBDIRS.map((s) => path.join(base, s))]) {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); created.push(dir); }
    }
    probeWritable(base);
    // `pathtimer` va aparte y nunca tumba el resultado: con una base de prueba
    // (baseOverride) no se toca.
    if (!baseOverride) {
      try {
        const timer = resolveTimerDir(runtime);
        if (!fs.existsSync(timer)) { fs.mkdirSync(timer, { recursive: true }); created.push(timer); }
      } catch (e) {
        log(`[MEGA_POS][vouchers] no se pudo crear la carpeta de timers: ${e.message}`);
      }
    }
    if (created.length) log(`[MEGA_POS][vouchers] carpetas creadas: ${created.join(', ')}`);
    return { ok: true, base, created };
  } catch (e) {
    log(`[MEGA_POS][vouchers] ${base} no está disponible para escribir: ${e.message}`);
    return { ok: false, base, created, error: e.message };
  }
};

/** Solo diagnóstico (prueba de escritura incluida, sin crear nada). */
const inspectVoucherDirs = (runtime, baseOverride) => {
  const base = baseOverride || resolveVoucherBase(runtime);
  const out = { base, exists: fs.existsSync(base), writable: false, missing: [], error: null };
  for (const s of VOUCHER_SUBDIRS) if (!fs.existsSync(path.join(base, s))) out.missing.push(s);
  if (out.exists) {
    try { probeWritable(base); out.writable = true; } catch (e) { out.error = e.message; }
  }
  return out;
};

module.exports = {
  vtidStatePath,
  snapshotRoot,
  parseState,
  inspectStateFile,
  isSnapshotWorthy,
  readSnapshot,
  snapshotState,
  restoreState,
  guardStateOnStart,
  watchState,
  resolveVoucherBase,
  resolveTimerDir,
  ensureVoucherDirs,
  inspectVoucherDirs,
  writeFileSafe,
  inspectConfigFile,
  inspectConfigFiles,
  healConfigFiles,
  CONFIG_REQUIRED_SECTIONS,
};
