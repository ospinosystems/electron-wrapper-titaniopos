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
 * Todo es best-effort: nada de aquí lanza ni impide arrancar el VPOS. Lo que
 * falle queda en el log y en el estado que lee el chequeo de caja.
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_SUFFIX = '.state-snapshots';
const HISTORY_KEEP = 5;
const DEFAULT_VOUCHER_BASE = 'C:\\voucher';
const VOUCHER_SUBDIRS = ['vouchers', 'archivosControl'];

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
  ensureVoucherDirs,
  inspectVoucherDirs,
};
