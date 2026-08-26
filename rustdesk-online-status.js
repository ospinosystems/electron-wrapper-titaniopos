/**
 * Estado REAL de cada caja en el servidor RustDesk (hbbs), sin pasar por el
 * backend del POS. Habla el protocolo de rendezvous por TCP: por cada remote_id
 * manda un PunchHoleRequest firmado con la key del self-host y clasifica la
 * respuesta de hbbs:
 *   - RelayResponse / pk firmada  → 'online'
 *   - failure OFFLINE             → 'offline'      (registró antes, ahora no está)
 *   - failure ID_NOT_EXIST        → 'unregistered' (nunca registró / key vieja)
 *   - timeout / cerrada           → 'unknown'
 * Todos en paralelo con un tope corto; cache de pocos segundos para no martillar.
 */
const net = require('net');

const HOST = 'rustdesk.titanio-pos.com';
const PORT = 21116;
const KEY = 'cpyYPJtZXVO4W3P28t3K1M5RiQxdpBZ+n9p81FmWVIU=';
const PER_QUERY_TIMEOUT_MS = 3000;
const CACHE_TTL_MS = 12000;

// ── protobuf mínimo ─────────────────────────────────────────────────────────
function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; out.push(n ? b | 0x80 : b); } while (n);
  return Buffer.from(out);
}
function tag(field, wire) { return varint((field << 3) | wire); }
function lenDelim(buf) { const b = Buffer.from(buf); return Buffer.concat([varint(b.length), b]); }
function frame(data) {
  const n = data.length;
  if (n <= 0x3f) return Buffer.concat([Buffer.from([n << 2]), data]);
  if (n <= 0x3fff) { const h = Buffer.alloc(2); h.writeUInt16LE((n << 2) | 1); return Buffer.concat([h, data]); }
  const h = Buffer.alloc(4); h.writeUInt32LE((n << 2) | 2); return Buffer.concat([h.subarray(0, 3), data]);
}
function readVarint(b, i) {
  let v = 0, sh = 0;
  while (i < b.length) { const c = b[i++]; v |= (c & 0x7f) << sh; if (!(c & 0x80)) break; sh += 7; }
  return [v >>> 0, i];
}
function parse(b) {
  let i = 0; const out = [];
  while (i < b.length) {
    let key; [key, i] = readVarint(b, i);
    const num = key >>> 3, wire = key & 7;
    if (wire === 0) { let v; [v, i] = readVarint(b, i); out.push([num, v]); }
    else if (wire === 2) { let l; [l, i] = readVarint(b, i); out.push([num, b.subarray(i, i + l)]); i += l; }
    else break;
  }
  return out;
}
function punchHoleFrame(id) {
  const req = Buffer.concat([
    tag(1, 2), lenDelim(id),
    tag(2, 0), varint(1),
    tag(3, 2), lenDelim(KEY),
    tag(4, 0), varint(0),
    tag(6, 2), lenDelim('1.4.2'),
  ]);
  return frame(Buffer.concat([tag(8, 2), lenDelim(req)]));
}
function classify(buf) {
  if (!buf || buf.length < 2) return 'unknown';
  const t = buf[0] & 3;
  const payload = buf.subarray(1 + t);
  for (const [num, val] of parse(payload)) {
    if (num === 19) return 'online';
    if (num === 11) {
      const m = new Map(parse(val));
      if (m.has(2) && m.has(4)) return 'online';
      const failure = m.get(3) || 0;
      return failure === 2 ? 'offline' : 'unregistered';
    }
  }
  return 'unknown';
}

function queryOne(id) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(r); } };
    const sock = net.createConnection({ host: HOST, port: PORT });
    sock.setTimeout(PER_QUERY_TIMEOUT_MS);
    sock.on('connect', () => { try { sock.write(punchHoleFrame(id)); } catch (_) { finish('unknown'); } });
    sock.on('data', (buf) => finish(classify(buf)));
    sock.on('timeout', () => finish('unknown'));
    sock.on('error', () => finish('unknown'));
    sock.on('close', () => finish('unknown'));
  });
}

let cache = { at: 0, map: {} };

/**
 * @param {string[]} ids
 * @returns {Promise<Record<string,string>>} id → online|offline|unregistered|unknown
 */
async function onlineStatus(ids) {
  const clean = [...new Set((ids || []).map((x) => String(x).trim()).filter(Boolean))];
  if (clean.length === 0) return {};

  const now = Date.now();
  const fresh = now - cache.at < CACHE_TTL_MS;
  const need = fresh ? clean.filter((id) => !(id in cache.map)) : clean;

  if (need.length) {
    const results = await Promise.all(need.map((id) => queryOne(id).then((st) => [id, st])));
    if (!fresh) cache = { at: now, map: {} };
    for (const [id, st] of results) cache.map[id] = st;
    cache.at = cache.at || now;
  }

  const out = {};
  for (const id of clean) out[id] = cache.map[id] || 'unknown';
  return out;
}

module.exports = { onlineStatus };
