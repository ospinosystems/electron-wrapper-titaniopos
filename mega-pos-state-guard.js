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
const vtidStateCopyPath = (runtime, vtid) => `${vtidStatePath(runtime, vtid)}_copia`;
const snapshotRoot = (runtime) => `${runtime}${SNAPSHOT_SUFFIX}`;
const snapshotFile = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, `${vtid}.ini`);
const snapshotMeta = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, `${vtid}.json`);
const snapshotHistoryDir = (runtime, vtid) => path.join(snapshotRoot(runtime), vtid, 'history');

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Plantilla mínima de `conf/<VTID>/<VTID>.ini` idéntica a la que genera
 * `VposMap.generarArchivoIni` en VPOS 3.16.0: `[multiempresa] <VTID>=<seq>`
 * es el consecutivo real de transacciones y `[<VTID>]` guarda solo la marca
 * temporal de reverso/advice pendiente.
 */
const buildDefaultStateIni = (vtid, seq) => [
  '[multiempresa]',
  `${vtid}=${seq}`,
  'nombreEmpresa=',
  'localidad=',
  'rif=',
  'MarcaCargaLLaves=0',
  '',
  `[${vtid}]`,
  'codigo=0',
  'seqnumber=',
  'seqnumberoriginal=',
  'pendingAdvice=',
  'pendingTrxExterna=',
  '',
].join('\r\n');

/**
 * Lee lo que importa del `<VTID>.ini` (verificado en VposUniversal.jar 3.16.0):
 *   - El consecutivo REAL de transacciones (`ConfiguracionVP.getSeqnum(vtid)` /
 *     `Transaccion.obtenerSecuencia`) vive en `[multiempresa] <VTID>=<N>`.
 *   - `[<VTID>] seqnumber=` es solo la marca temporal de reverso pendiente
 *     (`crearMarca`/`eliminarMarca`, vacía en operación normal).
 *
 * `seqnumber` en el objeto devuelto expone el consecutivo REAL (`[multiempresa]
 * <VTID>=`) para mantener compatibilidad con la UI de salud y los snapshots.
 */
const parseState = (text, vtid) => {
  const lines = String(text || '').split(/\r?\n/);
  const vtidLower = String(vtid || '').toLowerCase();
  const vtidKeyRe = vtid ? new RegExp(`^\\s*${escapeRegex(vtid)}\\s*=\\s*(.*)$`, 'i') : null;
  let section = null;
  let hasMultiempresa = false;
  let hasCounterKey = false;
  let counter = null;
  let hasSection = false;
  let hasSeqKey = false;
  let pendingSeqnumber = null;
  for (const line of lines) {
    const sec = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      if (section === 'multiempresa') hasMultiempresa = true;
      if (vtidLower && section === vtidLower) hasSection = true;
      continue;
    }
    if (section === 'multiempresa' && vtidKeyRe) {
      const kv = line.match(vtidKeyRe);
      if (kv) { hasCounterKey = true; counter = kv[1].trim(); }
    } else if (vtidLower && section === vtidLower) {
      const kv = line.match(/^\s*seqnumber\s*=\s*(.*)$/i);
      if (kv) { hasSeqKey = true; pendingSeqnumber = kv[1].trim(); }
    }
  }
  return {
    hasMultiempresa,
    hasCounterKey,
    hasSection,
    hasSeqKey,
    seqnumber: counter,
    pendingSeqnumber,
  };
};

/** El consecutivo como entero >= 0, o null si no tiene dígitos. */
const seqOf = (value) => (/^\d+$/.test(String(value ?? '').trim()) ? parseInt(String(value).trim(), 10) : null);

/**
 * Diagnóstico del archivo de estado: sano = existe, tiene bytes (sin nulos),
 * tiene `[multiempresa]` con `<VTID>=<entero >= 1>` y tiene la sección
 * `[<VTID>]`. Si el contador en `[multiempresa]` falta, está vacío o vale 0,
 * el VPOS lanza `EB` ("obtenerSecuencia: secuencia en cero").
 */
const inspectStateFile = (runtime, vtid) => {
  const file = vtidStatePath(runtime, vtid);
  const out = {
    path: file,
    exists: false,
    size: 0,
    hasMultiempresa: false,
    hasCounterKey: false,
    hasSection: false,
    hasSeqKey: false,
    seqnumber: null,
    pendingSeqnumber: null,
    healthy: false,
    reason: 'missing',
    mtime: null,
  };
  if (!vtid) return { ...out, reason: 'no-vtid' };
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return out; }
  out.exists = true;
  out.size = stat.size;
  out.mtime = stat.mtimeMs;
  if (!stat.size) return { ...out, reason: 'empty' };
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { return { ...out, reason: `unreadable: ${e.message}` }; }
  if (buf.includes(0)) return { ...out, reason: 'nulls' };
  const parsed = parseState(buf.toString('latin1'), vtid);
  Object.assign(out, parsed);
  if (!parsed.hasMultiempresa) return { ...out, reason: 'no-multiempresa' };
  if (!parsed.hasCounterKey) return { ...out, reason: 'no-counter' };
  if (!parsed.hasSection) return { ...out, reason: 'no-section' };
  const n = seqOf(parsed.seqnumber);
  if (n === null) return { ...out, reason: 'empty-seqnum' };
  if (n < 1) return { ...out, reason: 'zero-seqnum' };
  return { ...out, healthy: true, reason: null };
};

/** Solo vale la pena respaldar un estado sano con consecutivo real (> 0) en `[multiempresa] <VTID>=`. */
const isSnapshotWorthy = (state) => {
  if (!state || !state.healthy) return false;
  const n = seqOf(state.seqnumber);
  return n !== null && n > 0;
};

/**
 * ¿Hay que reponer el estado desde el respaldo al arrancar? Solo si está ROTO
 * (ausente, vacío, con nulos, sin `[multiempresa] <VTID>=`, sin `[<VTID>]`,
 * o contador vacío / en 0 que provoca EB). Un estado sano con consecutivo real
 * (>= 1) NO se pisa al arrancar aunque haya bajado respecto al respaldo: en
 * operación normal el consecutivo también baja entre lotes y el Merchant lo
 * aprueba. Un consecutivo atrasado lo corrige solo `planSequenceHeal`, y
 * únicamente tras un EB / X5.
 */
// eslint-disable-next-line no-unused-vars
const stateNeedsRestore = (state, _snapshot) => !state || !state.healthy;

const readSnapshot = (runtime, vtid) => {
  const file = snapshotFile(runtime, vtid);
  const out = { path: file, exists: false, content: null, at: null, seqnumber: null };
  if (!vtid) return out;
  try {
    out.content = fs.readFileSync(file, 'latin1');
    out.exists = out.content.length > 0;
  } catch (_) { return out; }
  const parsedSeq = parseState(out.content, vtid).seqnumber;
  try {
    const meta = JSON.parse(fs.readFileSync(snapshotMeta(runtime, vtid), 'utf8'));
    out.at = meta.at || null;
    out.seqnumber = parsedSeq ?? meta.seqnumber ?? null;
  } catch (_) {
    out.seqnumber = parsedSeq;
  }
  return out;
};

/**
 * El mayor consecutivo conocido de este VPOS: `maxSeqnumber` del meta, el respaldo y el historial.
 * Es de ESTA máquina (no se mezcla con otras cajas que compartan terminal).
 */
const readHighWater = (runtime, vtid) => {
  if (!vtid) return null;
  let best = null;
  const take = (v) => { const n = seqOf(v); if (n !== null && n > 0 && (best === null || n > best)) best = n; };
  try { take(JSON.parse(fs.readFileSync(snapshotMeta(runtime, vtid), 'utf8')).maxSeqnumber); } catch (_) {}
  const snap = readSnapshot(runtime, vtid);
  if (snap.exists) take(parseState(snap.content, vtid).seqnumber);
  try {
    const hist = snapshotHistoryDir(runtime, vtid);
    for (const n of fs.readdirSync(hist).filter((x) => x.endsWith('.ini'))) {
      try { take(parseState(fs.readFileSync(path.join(hist, n), 'latin1'), vtid).seqnumber); } catch (_) {}
    }
  } catch (_) {}
  return best;
};

/** Margen sobre el piso: el VPOS avanza de a 2 por cobro. */
const SEQUENCE_MARGIN = 2;

/**
 * ¿Qué haría la cura del consecutivo (solo tras un EB / X5)? Sin tocar nada:
 *   known   = el mayor entre la última del servidor y el mayor consecutivo local
 *   restore = el archivo está ausente, roto o con contador 0/vacío
 *   raise   = hay `known > 0` y el consecutivo actual falta, vale 0 o está `<= known`
 *             (incluye `current === known`, porque `obtenerSecuencia` usa el valor
 *             actual y luego incrementa: si `current === known` ese número ya chocó
 *             en el lote del Merchant; también aplica cuando el archivo no existe).
 *   floor   = max(current, known) + 2, garantizando estrictamente `floor > current`
 *             y `floor > known`.
 * Si el archivo está sano y `current > known` (o no hay `known` y el archivo es sano),
 * devuelve `needed: false` y no se reinicia el VPOS.
 */
const planSequenceHeal = (runtime, vtid, lastSequence = null) => {
  const state = inspectStateFile(runtime, vtid);
  const restore = stateNeedsRestore(state, readSnapshot(runtime, vtid));
  const local = readHighWater(runtime, vtid);
  const server = Number.isInteger(lastSequence) && lastSequence > 0 ? lastSequence : null;
  const known = Math.max(server || 0, local || 0) || null;
  const current = seqOf(state.seqnumber);
  const floor = known ? Math.max(current || 0, known) + SEQUENCE_MARGIN : null;
  const raise = Boolean(known && (current === null || current <= 0 || current <= known));
  return { needed: restore || raise, restore, raise, floor, current, local, server };
};

const writeFileAtomic = (file, content) => {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, content, 'latin1');
    try { fs.fsyncSync(fd); } catch (_) { /* FS sin fsync: se sigue */ }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
};

/**
 * Escribe atómicamente `conf/<VTID>/<VTID>.ini` y su espejo `<VTID>.ini_copia`
 * con los mismos bytes exactos. Al arrancar, `VposMap.crearArchivoConf` compara
 * el MD5 de ambos archivos y, si difieren, sobrescribe `<VTID>.ini` con el
 * `_copia` viejo ("Archivo no concuerda con la copia. Restaurado por copia").
 */
const writeStatePairAtomic = (runtime, vtid, content) => {
  const target = vtidStatePath(runtime, vtid);
  const copy = vtidStateCopyPath(runtime, vtid);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomic(target, content);
  writeFileAtomic(copy, content);
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
  // El mayor consecutivo que este VPOS llegó a tener: si se rehace en 0 y el respaldo se pisa, la cura
  // todavía sabe hasta dónde llegó (Guacara caja 4, 23/11/2026: 421 -> 0; el 421 se había perdido).
  const maxSeqnumber = Math.max(readHighWater(runtime, vtid) || 0, seqOf(state.seqnumber) || 0) || null;
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
    writeFileAtomic(snapshotMeta(runtime, vtid), JSON.stringify({ at: new Date().toISOString(), seqnumber: state.seqnumber, size: state.size, maxSeqnumber }));
    log(`[MEGA_POS][estado] respaldo de ${vtid} guardado (seqnumber=${state.seqnumber})`);
    return { saved: true, seqnumber: state.seqnumber };
  } catch (e) {
    log(`[MEGA_POS][estado] no se pudo respaldar ${vtid}: ${e.message}`);
    return { saved: false, reason: e.message };
  }
};

/**
 * Restaura el último respaldo sobre `conf/<VTID>/<VTID>.ini` y sincroniza
 * `<VTID>.ini_copia` con los mismos bytes exactos (chequeo MD5 de Megasoft).
 * El archivo dañado (si existe) se conserva al lado como `.ini.damaged-<fecha>`.
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
    writeStatePairAtomic(runtime, vtid, snap.content);
    try {
      const meta = JSON.parse(fs.readFileSync(snapshotMeta(runtime, vtid), 'utf8'));
      meta.restoredAt = new Date().toISOString();
      fs.writeFileSync(snapshotMeta(runtime, vtid), JSON.stringify(meta), 'utf8');
    } catch (_) {}
    log(`[MEGA_POS][estado] ${vtid} restaurado desde el respaldo (seqnumber=${snap.seqnumber}, de ${snap.at || '?'}) + _copia`);
    return { restored: true, seqnumber: snap.seqnumber, at: snap.at };
  } catch (e) {
    log(`[MEGA_POS][estado] no se pudo restaurar ${vtid}: ${e.message}`);
    return { restored: false, reason: e.message };
  }
};

/**
 * Lleva el consecutivo real `[multiempresa] <VTID>=` de `conf/<VTID>/<VTID>.ini`
 * a `value` (escritura atómica) y sincroniza `<VTID>.ini_copia` con los mismos
 * bytes exactos, conservando el resto del archivo intacto (incluida la sección
 * `[<VTID>]`). Si `<VTID>.ini` no existe o está vacío/corrupto, crea un archivo
 * mínimo válido con la plantilla de VPOS 3.16.0. Solo con el VPOS detenido.
 * @returns {{ ok: boolean, previous?: string|null, seqnumber?: number, created?: boolean, error?: string }}
 */
const setStateSeqnumber = (runtime, vtid, value, log = noop) => {
  const n = Number(value);
  if (!vtid || !Number.isInteger(n) || n < 1 || n > 99999999) return { ok: false, error: 'valor inválido' };
  const file = vtidStatePath(runtime, vtid);
  let buf = null;
  try { buf = fs.readFileSync(file); } catch (_) { buf = null; }

  const usable = buf && buf.length > 0 && !buf.includes(0);
  if (usable) {
    const text = buf.toString('latin1');
    const parsed = parseState(text, vtid);
    if (parsed.hasMultiempresa && parsed.hasSection) {
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/);
      const vtidKeyRe = new RegExp(`^(\\s*)(${escapeRegex(vtid)})\\s*=\\s*(.*)$`, 'i');
      let section = null;
      let previous = null;
      let done = false;
      let multiempresaHeader = -1;
      for (let i = 0; i < lines.length; i += 1) {
        const sec = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
        if (sec) {
          section = sec[1].trim().toLowerCase();
          if (section === 'multiempresa' && multiempresaHeader < 0) multiempresaHeader = i;
          continue;
        }
        if (section === 'multiempresa') {
          const kv = lines[i].match(vtidKeyRe);
          if (kv && !done) {
            previous = kv[3].trim();
            lines[i] = `${kv[1]}${kv[2]}=${n}`;
            done = true;
          }
        }
      }
      if (!done && multiempresaHeader >= 0) {
        lines.splice(multiempresaHeader + 1, 0, `${vtid}=${n}`);
        done = true;
      }
      if (done) {
        try {
          writeStatePairAtomic(runtime, vtid, lines.join(eol));
          log(`[MEGA_POS][estado] ${vtid}: [multiempresa] ${vtid} ${previous ?? '(sin clave)'} -> ${n} (+ _copia)`);
          return { ok: true, previous, seqnumber: n };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
    }
  }

  // Archivo ausente, vacío, con bytes nulos o sin las secciones requeridas:
  // conservar el dañado si existía y crear el par `<VTID>.ini` + `<VTID>.ini_copia`.
  try {
    if (buf !== null && fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(file, `${file}.damaged-${stamp}`); } catch (_) { fs.rmSync(file, { force: true }); }
    }
    writeStatePairAtomic(runtime, vtid, buildDefaultStateIni(vtid, n));
    log(`[MEGA_POS][estado] ${vtid}: archivo de estado creado con [multiempresa] ${vtid}=${n} (+ _copia)`);
    return { ok: true, previous: null, seqnumber: n, created: true };
  } catch (e) {
    return { ok: false, error: e.message };
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
  if (!stateNeedsRestore(state, readSnapshot(runtime, vtid))) {
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
  seqOf,
  readHighWater,
  planSequenceHeal,
  setStateSeqnumber,
  vtidStatePath,
  vtidStateCopyPath,
  buildDefaultStateIni,
  snapshotRoot,
  parseState,
  inspectStateFile,
  isSnapshotWorthy,
  stateNeedsRestore,
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
