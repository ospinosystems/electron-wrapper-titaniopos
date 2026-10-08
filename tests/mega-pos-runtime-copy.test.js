// node --test tests/mega-pos-runtime-copy.test.js
// Cubre la recopia del runtime del VPOS: el marcador ignora la versión de la
// app y el estado por VTID (conf/<VTID>/) sobrevive a la recopia.
const { test, after } = require('node:test');
const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INI = '[versionVPos]\r\nversion=3.16.0\r\n\r\n[SeqNum]\r\nseqnum=1\r\n';
const STATE = '[GTGUARA07]\r\nseqnumber=42\r\n';

const makeFixture = ({ marker, distroVersion = '3.16.0' }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpos-copy-'));
  roots.push(root);
  const source = path.join(root, 'resources', 'vpos-rest');
  fs.mkdirSync(path.join(source, 'conf', 'verifone'), { recursive: true });
  fs.mkdirSync(path.join(source, 'lib_rest'), { recursive: true });
  fs.writeFileSync(path.join(source, 'conf', 'vposconf.ini'), INI.replace('3.16.0', distroVersion));
  fs.writeFileSync(path.join(source, 'lib_rest', 'vposrestservice.jar'), 'jar');

  const userData = path.join(root, 'userData');
  const runtime = path.join(userData, 'vpos-rest');
  fs.mkdirSync(path.join(runtime, 'conf', 'GTGUARA07'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'conf', 'verifone'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'lib_rest'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'conf', 'vposconf.ini'), INI);
  fs.writeFileSync(path.join(runtime, 'conf', 'GTGUARA07', 'GTGUARA07.ini'), STATE);
  fs.writeFileSync(path.join(runtime, 'conf', 'GTGUARA07', 'GTGUARA07.ini_copia'), STATE);
  // Archivo suelto que el VPOS dejó dentro de una carpeta que SÍ viene en la distro.
  fs.writeFileSync(path.join(runtime, 'conf', 'verifone', 'llaves.dat'), 'pinpad');
  fs.writeFileSync(path.join(runtime, 'lib_rest', 'vposrestservice.jar'), 'old-jar');
  fs.writeFileSync(path.join(runtime, 'stale.txt'), 'de la distro vieja');
  if (marker) fs.writeFileSync(path.join(runtime, '.installed-version'), marker);

  process.resourcesPath = path.join(root, 'resources');
  const app = { getPath: () => userData, getVersion: () => '1.0.999' };
  return { root, source, runtime, app };
};

const load = () => {
  delete require.cache[require.resolve('../mega-pos-manager')];
  return require('../mega-pos-manager')._internals;
};

test('markerMatches acepta el formato nuevo y el viejo con versión de app', () => {
  const { markerMatches } = load();
  assert.equal(markerMatches('vpos-3.16.0', 'vpos-3.16.0'), true);
  assert.equal(markerMatches('1.0.246:vpos-3.16.0\n', 'vpos-3.16.0'), true);
  assert.equal(markerMatches('1.0.246:vpos-3.15.10', 'vpos-3.16.0'), false);
  assert.equal(markerMatches('', 'vpos-3.16.0'), false);
});

test('un marcador viejo con la misma distro NO recopia (un release de la app ya no borra el estado)', async () => {
  const { ensureRuntimeCopy } = load();
  const { runtime, app } = makeFixture({ marker: '1.0.246:vpos-3.16.0' });
  await ensureRuntimeCopy(app);
  assert.equal(fs.readFileSync(path.join(runtime, 'conf', 'GTGUARA07', 'GTGUARA07.ini'), 'utf8'), STATE);
  assert.equal(fs.readFileSync(path.join(runtime, 'lib_rest', 'vposrestservice.jar'), 'utf8'), 'old-jar');
  assert.equal(fs.existsSync(path.join(runtime, 'stale.txt')), true);
});

test('cambio de distro recopia todo pero conserva conf/<VTID>/', async () => {
  const { ensureRuntimeCopy } = load();
  const { runtime, app } = makeFixture({ marker: '1.0.200:vpos-3.15.10' });
  await ensureRuntimeCopy(app);
  assert.equal(fs.readFileSync(path.join(runtime, '.installed-version'), 'utf8'), 'vpos-3.16.0');
  assert.equal(fs.existsSync(path.join(runtime, 'stale.txt')), false, 'la distro vieja se borra');
  assert.equal(fs.readFileSync(path.join(runtime, 'lib_rest', 'vposrestservice.jar'), 'utf8'), 'jar');
  assert.equal(fs.readFileSync(path.join(runtime, 'conf', 'GTGUARA07', 'GTGUARA07.ini'), 'utf8'), STATE);
  assert.equal(fs.readFileSync(path.join(runtime, 'conf', 'GTGUARA07', 'GTGUARA07.ini_copia'), 'utf8'), STATE);
  assert.equal(fs.existsSync(`${runtime}.state-bak`), false, 'el respaldo temporal se limpia');
  // conf/verifone viene en la distro, pero el archivo que el VPOS dejó ahí sobrevive.
  assert.equal(fs.existsSync(path.join(runtime, 'conf', 'verifone')), true);
  assert.equal(fs.readFileSync(path.join(runtime, 'conf', 'verifone', 'llaves.dat'), 'utf8'), 'pinpad');
});

test('listVposStateDirs: carpeta ajena completa + archivo suelto en carpeta de la distro', () => {
  const { listVposStateDirs } = load();
  const { runtime, source } = makeFixture({ marker: null });
  assert.deepEqual(listVposStateDirs(source, runtime).sort(), ['GTGUARA07', path.join('verifone', 'llaves.dat')]);
});

test('sin marcador (primera instalación) copia y no falla sin estado previo', async () => {
  const { ensureRuntimeCopy, listVposStateDirs } = load();
  const { runtime, source, app } = makeFixture({ marker: null });
  fs.rmSync(path.join(runtime, 'conf', 'GTGUARA07'), { recursive: true, force: true });
  fs.rmSync(path.join(runtime, 'conf', 'verifone', 'llaves.dat'), { force: true });
  assert.deepEqual(listVposStateDirs(source, runtime), []);
  await ensureRuntimeCopy(app);
  assert.equal(fs.readFileSync(path.join(runtime, '.installed-version'), 'utf8'), 'vpos-3.16.0');
  assert.equal(fs.existsSync(`${runtime}.state-bak`), false);
});

test('candado: los starts concurrentes se suman a la operación en curso y los restarts se encolan', async () => {
  const { createSerializer } = load();
  const ops = createSerializer();
  const calls = [];
  const op = (name, ms) => () => new Promise((r) => setTimeout(() => { calls.push(name); r(name); }, ms));

  const a = ops.join(op('start-1', 30));
  const b = ops.join(op('start-2', 1)); // no debe ejecutarse: se suma a start-1
  const c = ops.enqueue(op('restart', 1)); // corre DESPUÉS de start-1
  const d = ops.join(op('start-3', 1)); // se suma al restart en curso
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(c, d);
  assert.deepEqual(await Promise.all([a, b, c, d]), ['start-1', 'start-1', 'restart', 'restart']);
  assert.deepEqual(calls, ['start-1', 'restart']);

  // Terminado todo, un start nuevo abre otra operación; y un fallo no traba la cola.
  const e = ops.enqueue(() => Promise.reject(new Error('boom')));
  await assert.rejects(e, /boom/);
  const f = ops.join(op('start-4', 1));
  assert.notEqual(f, a);
  assert.equal(await f, 'start-4');
});
