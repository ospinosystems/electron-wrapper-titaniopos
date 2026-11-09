// node --test tests/mega-pos-state-guard.test.js
// Guardia del estado del VPOS por terminal (conf/<VTID>/<VTID>.ini) y de la
// carpeta de resultados: respaldo propio, restauración al arrancar, reparación.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../mega-pos-state-guard');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const VTID = 'GTGUARA07';
const state = (seq) => `[vigenciaVersion]\r\nfecha=23/10/2026 10:07\r\n\r\n[multiempresa]\r\n${VTID}=4\r\n\r\n[${VTID}]\r\ncodigo=0\r\nseqnumber=${seq}\r\nseqnumberoriginal=\r\npendingAdvice=\r\n`;

const fixture = ({ stateContent } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpos-guard-'));
  roots.push(root);
  const runtime = path.join(root, 'userData', 'vpos-rest');
  fs.mkdirSync(path.join(runtime, 'conf', VTID), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'conf', 'vposconf.ini'), `[path]\r\npath=${path.join(root, 'voucher')}\\\r\n`);
  if (stateContent !== undefined) fs.writeFileSync(guard.vtidStatePath(runtime, VTID), stateContent, 'latin1');
  return { root, runtime };
};

test('inspectStateFile: sano, vacío, truncado y ausente', () => {
  const { runtime } = fixture({ stateContent: state('42') });
  let s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, true);
  assert.equal(s.seqnumber, '42');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, false);
  assert.equal(s.reason, 'empty');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '[vigenciaVersion]\r\nfecha=x\r\n');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.reason, 'no-section');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), `[${VTID}]\r\ncodigo=0\r\n`);
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.reason, 'no-seqnumber');

  fs.rmSync(guard.vtidStatePath(runtime, VTID));
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.exists, false);
  assert.equal(s.reason, 'missing');
});

test('un terminal nuevo (seqnumber vacío) es sano pero no se respalda', () => {
  const { runtime } = fixture({ stateContent: state('') });
  const s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, true);
  assert.equal(guard.isSnapshotWorthy(s), false);
  const r = guard.snapshotState(runtime, VTID);
  assert.equal(r.saved, false);
  assert.equal(guard.readSnapshot(runtime, VTID).exists, false);
});

test('snapshotState guarda fuera del runtime, solo si cambió, con historial acotado', () => {
  const { runtime } = fixture({ stateContent: state('10') });
  assert.equal(guard.snapshotState(runtime, VTID).saved, true);
  const snap = guard.readSnapshot(runtime, VTID);
  assert.equal(snap.exists, true);
  assert.equal(snap.seqnumber, '10');
  assert.ok(!snap.path.startsWith(runtime + path.sep), 'el respaldo vive fuera del runtime (la recopia lo borra)');
  assert.ok(snap.path.startsWith(guard.snapshotRoot(runtime)));

  assert.equal(guard.snapshotState(runtime, VTID).reason, 'unchanged');

  for (let i = 11; i <= 20; i++) {
    fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state(String(i)), 'latin1');
    assert.equal(guard.snapshotState(runtime, VTID).saved, true);
  }
  assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '20');
  const hist = fs.readdirSync(path.join(guard.snapshotRoot(runtime), VTID, 'history'));
  assert.equal(hist.length, 5);
});

test('guardStateOnStart restaura el respaldo cuando el archivo quedó en 0 bytes', () => {
  const { runtime } = fixture({ stateContent: state('77') });
  assert.equal(guard.guardStateOnStart(runtime, VTID).action, 'snapshot');
  // Corte de luz a mitad de escritura: el VPOS deja el archivo vacío.
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '');
  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'restored');
  assert.equal(r.state.healthy, true);
  assert.equal(r.state.seqnumber, '77');
  const damaged = fs.readdirSync(path.join(runtime, 'conf', VTID)).filter((n) => n.includes('.damaged-'));
  assert.equal(damaged.length, 1, 'el archivo dañado se conserva al lado');
});

test('guardStateOnStart restaura también cuando la carpeta del terminal desapareció', () => {
  const { runtime } = fixture({ stateContent: state('5') });
  guard.snapshotState(runtime, VTID);
  fs.rmSync(path.join(runtime, 'conf', VTID), { recursive: true, force: true });
  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'restored');
  assert.equal(fs.readFileSync(guard.vtidStatePath(runtime, VTID), 'latin1'), state('5'));
});

test('sin respaldo: un archivo dañado se deja al VPOS y uno ausente es un terminal nuevo', () => {
  const { runtime } = fixture({ stateContent: '' });
  assert.equal(guard.guardStateOnStart(runtime, VTID).action, 'unhealthy-no-backup');
  fs.rmSync(guard.vtidStatePath(runtime, VTID));
  assert.equal(guard.guardStateOnStart(runtime, VTID).action, 'fresh');
  assert.equal(guard.guardStateOnStart(runtime, '').action, 'none');
});

test('un estado sano NUNCA se pisa con el respaldo (aunque el respaldo sea más viejo)', () => {
  const { runtime } = fixture({ stateContent: state('100') });
  guard.snapshotState(runtime, VTID);
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('250'), 'latin1');
  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'snapshot');
  assert.equal(r.state.seqnumber, '250');
  assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '250');
});

test('watchState respalda al cambiar el archivo y con poke()', async () => {
  const { runtime } = fixture({ stateContent: state('1') });
  const w = guard.watchState(runtime, VTID, () => {}, 60000);
  try {
    assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '1');
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('2'), 'latin1');
    w.poke();
    assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '2');
  } finally {
    w.stop();
  }
});

test('ensureVoucherDirs crea la base de [path] y sus subcarpetas, y prueba la escritura', () => {
  const { root, runtime } = fixture();
  const base = path.join(root, 'voucher');
  assert.equal(guard.resolveVoucherBase(runtime), base);
  const r = guard.ensureVoucherDirs(runtime);
  assert.equal(r.ok, true);
  assert.equal(r.base, base);
  assert.equal(r.created.length, 3);
  assert.ok(fs.existsSync(path.join(base, 'vouchers')));
  assert.ok(fs.existsSync(path.join(base, 'archivosControl')));
  assert.equal(guard.ensureVoucherDirs(runtime).created.length, 0);
  const i = guard.inspectVoucherDirs(runtime);
  assert.equal(i.exists, true);
  assert.equal(i.writable, true);
  assert.deepEqual(i.missing, []);
});

test('ensureVoucherDirs reporta (sin lanzar) cuando la ruta no se puede crear', () => {
  const { root, runtime } = fixture();
  // Un ARCHIVO donde debería ir la carpeta: mkdir falla.
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'x');
  const r = guard.ensureVoucherDirs(runtime, () => {}, blocked);
  assert.equal(r.ok, false);
  assert.ok(r.error);
  const i = guard.inspectVoucherDirs(runtime, blocked);
  assert.equal(i.writable, false);
});
