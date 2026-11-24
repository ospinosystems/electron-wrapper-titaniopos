// node --test tests/mega-pos-state-guard.test.js
// Guardia del estado del VPOS por terminal (conf/<VTID>/<VTID>.ini) y de la
// carpeta de resultados: respaldo propio, restauración al arrancar, reparación.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../mega-pos-state-guard');

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const VTID = 'GTGUARA07';
// Formato real de VPOS 3.16.0: el consecutivo vive en [multiempresa] <VTID>=N;
// [<VTID>] seqnumber= queda vacío en operación normal (marca de reverso pendiente).
const state = (seq, pendingSeq = '') =>
  `[vigenciaVersion]\r\nfecha=23/10/2026 10:07\r\n\r\n[multiempresa]\r\n${VTID}=${seq}\r\nnombreEmpresa=\r\nlocalidad=\r\nrif=\r\nMarcaCargaLLaves=0\r\n\r\n[${VTID}]\r\ncodigo=0\r\nseqnumber=${pendingSeq}\r\nseqnumberoriginal=\r\npendingAdvice=\r\npendingTrxExterna=\r\n`;

const fixture = ({ stateContent } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpos-guard-'));
  roots.push(root);
  const runtime = path.join(root, 'userData', 'vpos-rest');
  fs.mkdirSync(path.join(runtime, 'conf', VTID), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'conf', 'vposconf.ini'), `[path]\r\npath=${path.join(root, 'voucher')}\\\r\n[SeqNum]\r\nseqnum=1\r\n[vtid]\r\nvtid=${VTID}\r\nid=0007\r\n`);
  if (stateContent !== undefined) fs.writeFileSync(guard.vtidStatePath(runtime, VTID), stateContent, 'latin1');
  return { root, runtime };
};

test('inspectStateFile: lee [multiempresa] <VTID>=N con [<VTID>] seqnumber vacío y detecta rotos', () => {
  const { runtime } = fixture({ stateContent: state('42', '') });
  let s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, true);
  assert.equal(s.seqnumber, '42');
  assert.equal(s.pendingSeqnumber, '');

  // Aunque [<VTID>] seqnumber tenga un valor viejo, el consecutivo real es [multiempresa] <VTID>=.
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('88', '12'), 'latin1');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, true);
  assert.equal(s.seqnumber, '88');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, false);
  assert.equal(s.reason, 'empty');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), Buffer.alloc(64));
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, false);
  assert.equal(s.reason, 'nulls');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '[vigenciaVersion]\r\nfecha=x\r\n');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.reason, 'no-multiempresa');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), `[multiempresa]\r\nnombreEmpresa=\r\n[${VTID}]\r\ncodigo=0\r\n`);
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.reason, 'no-counter');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), `[multiempresa]\r\n${VTID}=5\r\n`);
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.reason, 'no-section');

  // Contador en 0 o vacío provoca EB en VposUniversal.jar ("obtenerSecuencia: secuencia en cero").
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('0'), 'latin1');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, false);
  assert.equal(s.reason, 'zero-seqnum');

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state(''), 'latin1');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.healthy, false);
  assert.equal(s.reason, 'empty-seqnum');

  fs.rmSync(guard.vtidStatePath(runtime, VTID));
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(s.exists, false);
  assert.equal(s.reason, 'missing');
});

test('un contador vacío o en 0 no es respaldable; con [multiempresa] <VTID>=N (>0) sí se respalda aunque seqnumber esté vacío', () => {
  const { runtime } = fixture({ stateContent: state('0') });
  let s = guard.inspectStateFile(runtime, VTID);
  assert.equal(guard.isSnapshotWorthy(s), false);
  assert.equal(guard.snapshotState(runtime, VTID).saved, false);
  assert.equal(guard.readSnapshot(runtime, VTID).exists, false);

  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('15', ''), 'latin1');
  s = guard.inspectStateFile(runtime, VTID);
  assert.equal(guard.isSnapshotWorthy(s), true);
  assert.equal(guard.snapshotState(runtime, VTID).saved, true);
  assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '15');
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

test('guardStateOnStart restaura el respaldo cuando el archivo quedó en 0 bytes y sincroniza _copia (MD5)', () => {
  const { runtime } = fixture({ stateContent: state('77') });
  assert.equal(guard.guardStateOnStart(runtime, VTID).action, 'snapshot');
  // Corte de luz a mitad de escritura: el VPOS deja el archivo vacío y _copia viejo.
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '');
  fs.writeFileSync(guard.vtidStateCopyPath(runtime, VTID), state('1'), 'latin1');
  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'restored');
  assert.equal(r.state.healthy, true);
  assert.equal(r.state.seqnumber, '77');
  const iniBuf = fs.readFileSync(guard.vtidStatePath(runtime, VTID));
  const copyBuf = fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID));
  assert.deepEqual(iniBuf, copyBuf, '<VTID>.ini_copia debe ser byte-a-byte idéntico');
  assert.equal(md5(iniBuf), md5(copyBuf), 'MD5 de <VTID>.ini y <VTID>.ini_copia deben coincidir');
  const damaged = fs.readdirSync(path.join(runtime, 'conf', VTID)).filter((n) => n.includes('.damaged-'));
  assert.equal(damaged.length, 1, 'el archivo dañado se conserva al lado');
});

test('guardStateOnStart restaura también cuando la carpeta del terminal desapareció y crea _copia idéntico', () => {
  const { runtime } = fixture({ stateContent: state('5') });
  guard.snapshotState(runtime, VTID);
  fs.rmSync(path.join(runtime, 'conf', VTID), { recursive: true, force: true });
  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'restored');
  assert.equal(fs.readFileSync(guard.vtidStatePath(runtime, VTID), 'latin1'), state('5'));
  assert.equal(fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID), 'latin1'), state('5'));
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

test('un contador vacío en [multiempresa] (EB) se restaura desde el respaldo y sincroniza _copia; planSequenceHeal también lo sube', () => {
  const { runtime } = fixture({ stateContent: state('11689') });
  guard.snapshotState(runtime, VTID);
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state(''), 'latin1');
  assert.equal(guard.inspectStateFile(runtime, VTID).healthy, false);
  assert.equal(guard.inspectStateFile(runtime, VTID).reason, 'empty-seqnum');
  // Antes de arrancar, planSequenceHeal también detecta que debe restaurar y subir por encima de 11689.
  const p = guard.planSequenceHeal(runtime, VTID, null);
  assert.equal(p.restore, true);
  assert.equal(p.raise, true);
  assert.equal(p.floor, 11691);

  const r = guard.guardStateOnStart(runtime, VTID);
  assert.equal(r.action, 'restored');
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '11689');
  assert.equal(
    md5(fs.readFileSync(guard.vtidStatePath(runtime, VTID))),
    md5(fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID))),
  );
});

test('stateNeedsRestore: roto sí; con consecutivo real nunca (también si bajó); terminal nuevo sin respaldo no', () => {
  const snap = (seq) => ({ exists: true, seqnumber: seq });
  assert.equal(guard.stateNeedsRestore({ healthy: false }, snap('5')), true);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '7' }, snap('900')), false);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '900' }, snap('900')), false);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '901' }, snap('900')), false);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '' }, { exists: false }), false);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '' }, snap('')), false);
  assert.equal(guard.stateNeedsRestore({ healthy: true, seqnumber: '' }, snap('42')), false);
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

// ─── Archivos de configuración (conf/*.ini) ─────────────────────────────────

const GOOD_CONF = '[server]\r\nhost=\r\nport=\r\n\r\n[SeqNum]\r\nseqnum=1\r\n\r\n[vtid]\r\nvtid=\r\nid=\r\n\r\n[path]\r\npath=C:\\voucher\\\r\npathtimer=C:\\timer\\\r\n';
const GOOD_UNIVERSAL = '[COMPRA_MEDIOS_PAGO]\r\nactivo=0\r\n';

const confFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpos-conf-'));
  roots.push(root);
  const source = path.join(root, 'resources', 'vpos-rest');
  const runtime = path.join(root, 'userData', 'vpos-rest');
  for (const base of [source, runtime]) {
    fs.mkdirSync(path.join(base, 'conf', 'verifone'), { recursive: true });
    fs.writeFileSync(path.join(base, 'conf', 'vposconf.ini'), GOOD_CONF, 'latin1');
    fs.writeFileSync(path.join(base, 'conf', 'vposuniversal.ini'), GOOD_UNIVERSAL, 'latin1');
    fs.writeFileSync(path.join(base, 'conf', 'vposerror.ini'), '[codretorno]\r\n00=APROBADA\r\n', 'latin1');
    fs.writeFileSync(path.join(base, 'conf', 'winpos.ini'), ''); // vacío de fábrica
    fs.writeFileSync(path.join(base, 'conf', 'verifone', 'verifone.ini'), '[x]\r\n', 'latin1');
  }
  return { root, source, runtime, conf: (n) => path.join(runtime, 'conf', n) };
};

test('inspectConfigFile: sano, en ceros, vacío, sin secciones y ausente', () => {
  const { conf } = confFixture();
  const sections = guard.CONFIG_REQUIRED_SECTIONS['vposconf.ini'];
  assert.equal(guard.inspectConfigFile(conf('vposconf.ini'), sections).healthy, true);

  // Caso real (Guacara caja 3): 11.397 bytes, 11.208 nulos.
  fs.writeFileSync(conf('vposconf.ini'), Buffer.concat([Buffer.from('[server]\r\n'), Buffer.alloc(11208)]));
  let r = guard.inspectConfigFile(conf('vposconf.ini'), sections);
  assert.equal(r.healthy, false);
  assert.equal(r.reason, 'nulls');
  assert.equal(r.nulls, 11208);

  fs.writeFileSync(conf('vposconf.ini'), '');
  assert.equal(guard.inspectConfigFile(conf('vposconf.ini'), sections).reason, 'empty');

  fs.writeFileSync(conf('vposconf.ini'), '[server]\r\nhost=x\r\n');
  r = guard.inspectConfigFile(conf('vposconf.ini'), sections);
  assert.equal(r.reason, 'no-sections');
  assert.deepEqual(r.missingSections, ['vtid', 'path', 'SeqNum']);

  fs.rmSync(conf('vposconf.ini'));
  assert.equal(guard.inspectConfigFile(conf('vposconf.ini'), sections).reason, 'missing');
});

test('healConfigFiles repone vposconf.ini en ceros desde la distro y conserva el dañado', () => {
  const { source, runtime, conf } = confFixture();
  fs.writeFileSync(conf('vposconf.ini'), Buffer.alloc(11397));
  const logs = [];
  const r = guard.healConfigFiles(source, runtime, (m) => logs.push(m));
  assert.equal(r.ok, true);
  assert.deepEqual(r.healed, [{ name: 'vposconf.ini', reason: 'nulls' }]);
  assert.equal(fs.readFileSync(conf('vposconf.ini'), 'latin1'), GOOD_CONF);
  const kept = fs.readdirSync(path.join(runtime, 'conf')).filter((n) => n.startsWith('vposconf.ini.corrupto-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.statSync(path.join(runtime, 'conf', kept[0])).size, 11397);
  assert.ok(logs.some((l) => l.includes('repuesto desde la distribución')));
  // Segunda pasada: nada que hacer.
  assert.deepEqual(guard.healConfigFiles(source, runtime).healed, []);
});

test('healConfigFiles: ausente, truncado y cualquier otro archivo de conf/ en ceros', () => {
  const { source, runtime, conf } = confFixture();
  fs.rmSync(conf('vposuniversal.ini'));
  fs.writeFileSync(conf('vposconf.ini'), '[server]\r\nhost=x\r\n'); // truncado: faltan secciones
  fs.writeFileSync(conf('vposerror.ini'), Buffer.alloc(300));
  const r = guard.healConfigFiles(source, runtime);
  assert.deepEqual(r.healed.map((h) => `${h.name}:${h.reason}`).sort(), ['vposconf.ini:no-sections', 'vposerror.ini:nulls', 'vposuniversal.ini:missing']);
  assert.equal(guard.inspectConfigFiles(runtime).every((f) => f.healthy), true);
});

test('healConfigFiles NO toca archivos sanos (config de la caja), ni los vacíos de fábrica, ni subcarpetas', () => {
  const { source, runtime, conf } = confFixture();
  const custom = GOOD_CONF.replace('host=', 'host=ssl.megasoftve.com').replace('vtid=\r\n', 'vtid=GTGUARA03\r\n');
  fs.writeFileSync(conf('vposconf.ini'), custom, 'latin1');
  fs.writeFileSync(path.join(runtime, 'conf', 'verifone', 'verifone.ini'), Buffer.alloc(50));
  const r = guard.healConfigFiles(source, runtime);
  assert.deepEqual(r.healed, []);
  assert.equal(fs.readFileSync(conf('vposconf.ini'), 'latin1'), custom);
  assert.equal(fs.statSync(conf('winpos.ini')).size, 0);
  assert.equal(fs.statSync(path.join(runtime, 'conf', 'verifone', 'verifone.ini')).size, 50);
});

test('healConfigFiles no pisa nada si la copia de la distro tampoco es válida', () => {
  const { source, runtime, conf } = confFixture();
  fs.writeFileSync(path.join(source, 'conf', 'vposconf.ini'), '[otra]\r\n');
  fs.writeFileSync(conf('vposconf.ini'), Buffer.alloc(100));
  const r = guard.healConfigFiles(source, runtime);
  assert.deepEqual(r.healed, []);
  assert.equal(fs.statSync(conf('vposconf.ini')).size, 100);
});

test('healConfigFiles conserva solo los últimos 3 dañados', async () => {
  const { source, runtime, conf } = confFixture();
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(conf('vposconf.ini'), Buffer.alloc(10 + i));
    guard.healConfigFiles(source, runtime);
    await new Promise((r) => setTimeout(r, 5));
  }
  const kept = fs.readdirSync(path.join(runtime, 'conf')).filter((n) => n.startsWith('vposconf.ini.corrupto-'));
  assert.equal(kept.length, 3);
});

test('writeFileSafe: no reescribe si no cambió, y escribe sin dejar temporales', () => {
  const { runtime, conf } = confFixture();
  const f = conf('vposconf.ini');
  const before = fs.statSync(f).mtimeMs;
  assert.equal(guard.writeFileSafe(f, GOOD_CONF, 'latin1'), false);
  assert.equal(fs.statSync(f).mtimeMs, before);
  assert.equal(guard.writeFileSafe(f, GOOD_CONF + 'x=1\r\n', 'latin1'), true);
  assert.equal(fs.readFileSync(f, 'latin1'), GOOD_CONF + 'x=1\r\n');
  assert.deepEqual(fs.readdirSync(path.join(runtime, 'conf')).filter((n) => n.includes('.tmp-')), []);
  // Archivo nuevo.
  assert.equal(guard.writeFileSafe(conf('nuevo.ini'), 'a=1', 'utf8'), true);
});

test('resolveTimerDir lee pathtimer del ini y cae a C:\\timer', () => {
  const { runtime, conf } = confFixture();
  assert.equal(guard.resolveTimerDir(runtime), 'C:\\timer');
  fs.writeFileSync(conf('vposconf.ini'), '[path]\r\npath=D:\\v\\\r\npathtimer=D:\\t\\\r\n');
  assert.equal(guard.resolveTimerDir(runtime), 'D:\\t');
  fs.writeFileSync(conf('vposconf.ini'), Buffer.alloc(40));
  assert.equal(guard.resolveTimerDir(runtime), 'C:\\timer');
});

test('integración: un vposconf.ini en ceros queda repuesto Y con la config de la caja aplicada', () => {
  const { source, runtime, conf } = confFixture();
  const { _internals: { applyConfigToIni } } = require('../mega-pos-manager');
  const cfg = { serverHost: 'ssl.megasoftve.com', serverPort: '4772', ssl: true, vtid: 'GTGUARA03', id: '0003' };
  fs.writeFileSync(conf('vposconf.ini'), Buffer.alloc(11397));
  // Sin la reposición, applyConfigToIni no encuentra secciones y el archivo sigue inservible.
  applyConfigToIni(runtime, cfg);
  assert.equal(guard.inspectConfigFile(conf('vposconf.ini'), ['server']).healthy, false);

  guard.healConfigFiles(source, runtime);
  applyConfigToIni(runtime, cfg);
  const txt = fs.readFileSync(conf('vposconf.ini'), 'utf8');
  assert.match(txt, /host=ssl\.megasoftve\.com/);
  assert.match(txt, /vtid=GTGUARA03/);
  assert.match(txt, /id=0003/);
  assert.equal(guard.inspectConfigFile(conf('vposconf.ini'), guard.CONFIG_REQUIRED_SECTIONS['vposconf.ini']).healthy, true);
});

// ─── Cura del consecutivo (Guacara caja 4, 23/11/2026: 421 -> 0 -> 2) ───
// En operación normal el consecutivo también baja (prod 15-23/11: 179 bajadas en 33.280 aprobados) y el
// Merchant aprueba: el arranque y el respaldo no lo tocan; solo la cura, tras un EB / X5, lo sube.

test('un consecutivo que baja NO se restaura al arrancar y el respaldo lo sigue, pero el mayor queda guardado', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('4'), 'latin1');
  assert.equal(guard.guardStateOnStart(runtime, VTID).action === 'restored', false);
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '4');
  guard.snapshotState(runtime, VTID);
  assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '4');
  assert.equal(guard.readHighWater(runtime, VTID), 421);
});

test('el mayor consecutivo sobrevive aunque el historial ya no tenga el 421', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  for (const n of ['0', '2', '4', '6', '8', '10', '12']) {
    fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state(n), 'latin1');
    guard.snapshotState(runtime, VTID);
  }
  assert.equal(guard.readHighWater(runtime, VTID), 421);
});

test('planSequenceHeal: atrasado respecto al mayor local -> subir a mayor+2', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('2'), 'latin1');
  const p = guard.planSequenceHeal(runtime, VTID, null);
  assert.equal(p.needed, true);
  assert.equal(p.raise, true);
  assert.equal(p.floor, 423);
});

test('planSequenceHeal: la última del servidor gana si es mayor', () => {
  const { runtime } = fixture({ stateContent: state('100') });
  guard.snapshotState(runtime, VTID);
  const p = guard.planSequenceHeal(runtime, VTID, 500);
  assert.equal(p.floor, 502);
  assert.equal(p.raise, true);
});

test('planSequenceHeal: current === known debe subir (X5 con consecutivo empatado en el lote)', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  const pServer = guard.planSequenceHeal(runtime, VTID, 421);
  assert.equal(pServer.needed, true);
  assert.equal(pServer.raise, true);
  assert.ok(pServer.floor > 421);
  assert.equal(pServer.floor, 423);

  const pLocalOnly = guard.planSequenceHeal(runtime, VTID, null);
  assert.equal(pLocalOnly.needed, true);
  assert.equal(pLocalOnly.raise, true);
  assert.equal(pLocalOnly.floor, 423);
});

test('planSequenceHeal: estrictamente por encima de known (current > known) -> nada que hacer', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  // El archivo avanzó por encima tanto del respaldo local (421) como del servidor (300).
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), state('425'), 'latin1');
  assert.equal(guard.planSequenceHeal(runtime, VTID, 300).needed, false);
  assert.equal(guard.planSequenceHeal(runtime, VTID, 421).needed, false);
  assert.equal(guard.planSequenceHeal(runtime, VTID, null).needed, false);
});

test('planSequenceHeal: archivo ausente (state.exists === false) pero con lastSequence del servidor -> sube', () => {
  const { runtime } = fixture(); // no crea <VTID>.ini ni hay snapshot
  const p = guard.planSequenceHeal(runtime, VTID, 510);
  assert.equal(p.needed, true);
  assert.equal(p.restore, true);
  assert.equal(p.raise, true);
  assert.equal(p.current, null);
  assert.equal(p.floor, 512);
});

test('planSequenceHeal: archivo roto con respaldo -> restaurar', () => {
  const { runtime } = fixture({ stateContent: state('421') });
  guard.snapshotState(runtime, VTID);
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '\0\0\0', 'latin1');
  assert.equal(guard.planSequenceHeal(runtime, VTID, null).restore, true);
});

test('setStateSeqnumber actualiza [multiempresa] <VTID>=N sin tocar [<VTID>] seqnumber= y sincroniza _copia (MD5)', () => {
  const { runtime } = fixture({ stateContent: state('2', '') });
  // _copia viejo con otro valor para comprobar que queda sobrescrito idéntico.
  fs.writeFileSync(guard.vtidStateCopyPath(runtime, VTID), state('2', ''), 'latin1');
  const r = guard.setStateSeqnumber(runtime, VTID, 423);
  assert.equal(r.ok, true);
  assert.equal(r.previous, '2');
  const iniBuf = fs.readFileSync(guard.vtidStatePath(runtime, VTID));
  const copyBuf = fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID));
  assert.deepEqual(iniBuf, copyBuf, '<VTID>.ini y <VTID>.ini_copia deben ser byte-a-byte idénticos');
  assert.equal(md5(iniBuf), md5(copyBuf));
  const text = iniBuf.toString('latin1');
  assert.match(text, new RegExp(`\\[multiempresa\\]\\r\\n${VTID}=423\\r\\n`));
  // [<VTID>] seqnumber= (marca de reverso pendiente) NO se altera.
  assert.match(text, /seqnumber=\r\n/);
  assert.match(text, /pendingAdvice=/);
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '423');
});

test('setStateSeqnumber crea <VTID>.ini + <VTID>.ini_copia válidos cuando el archivo faltaba o estaba corrupto', () => {
  const { runtime } = fixture(); // archivo ausente
  const r1 = guard.setStateSeqnumber(runtime, VTID, 512);
  assert.equal(r1.ok, true);
  assert.equal(r1.created, true);
  assert.equal(guard.inspectStateFile(runtime, VTID).healthy, true);
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '512');
  assert.equal(
    md5(fs.readFileSync(guard.vtidStatePath(runtime, VTID))),
    md5(fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID))),
  );

  // Archivo sin secciones / corrupto: se respalda como .damaged y se crea limpio.
  fs.writeFileSync(guard.vtidStatePath(runtime, VTID), '[otra]\r\nx=1\r\n', 'latin1');
  const r2 = guard.setStateSeqnumber(runtime, VTID, 600);
  assert.equal(r2.ok, true);
  assert.equal(r2.created, true);
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '600');
  assert.equal(
    md5(fs.readFileSync(guard.vtidStatePath(runtime, VTID))),
    md5(fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID))),
  );
  const damaged = fs.readdirSync(path.join(runtime, 'conf', VTID)).filter((n) => n.includes('.damaged-'));
  assert.equal(damaged.length, 1);
});

test('setStateSeqnumber rechaza valores inválidos', () => {
  const { runtime } = fixture({ stateContent: state('10') });
  assert.equal(guard.setStateSeqnumber(runtime, VTID, 0).ok, false);
  assert.equal(guard.setStateSeqnumber(runtime, VTID, -5).ok, false);
  assert.equal(guard.setStateSeqnumber(runtime, VTID, 'abc').ok, false);
  assert.equal(guard.setStateSeqnumber(runtime, '', 10).ok, false);
});

test('setSeqNum (herramienta soporte) actualiza vposconf.ini + [multiempresa] <VTID>=N + <VTID>.ini_copia', async () => {
  const { runtime } = fixture({ stateContent: state('14', '') });
  const { setSeqNum } = require('../mega-pos-manager');
  const r = await setSeqNum(runtime, 700);
  assert.equal(r.success, true);
  assert.equal(r.next, 700);
  assert.equal(r.previous, '14');
  assert.equal(r.vtid, VTID);
  assert.match(fs.readFileSync(path.join(runtime, 'conf', 'vposconf.ini'), 'utf8'), /seqnum=700/);
  assert.equal(guard.inspectStateFile(runtime, VTID).seqnumber, '700');
  assert.equal(
    md5(fs.readFileSync(guard.vtidStatePath(runtime, VTID))),
    md5(fs.readFileSync(guard.vtidStateCopyPath(runtime, VTID))),
  );
  assert.equal(guard.readSnapshot(runtime, VTID).seqnumber, '700');
});

test('stopMegaPosServer mata VPOS externo y espera a que suelte :8085 (mock, sin tocar puertos reales)', async () => {
  const { stopMegaPosServer } = require('../mega-pos-manager');
  let alive = true;
  let pingCalls = 0;
  let killedExternal = 0;
  const res = await stopMegaPosServer({
    ping: async () => {
      pingCalls += 1;
      if (killedExternal > 0 && pingCalls >= 3) alive = false;
      return alive;
    },
    killExternal: async () => { killedExternal += 1; },
    maxAttempts: 5,
    intervalMs: 10,
  });
  assert.equal(killedExternal, 1);
  assert.equal(res.stopped, true);
  assert.ok(pingCalls >= 3);
});

test('killExternalVpos y killAllJava usan execFile asíncrono con windowsHide sin bloquear el event loop', async () => {
  const { _internals: { killExternalVpos, killAllJava } } = require('../mega-pos-manager');
  if (process.platform !== 'win32') return;
  const calls = [];
  let timerFiredDuringExec = false;
  const fakeExec = (cmd, args, opts) =>
    new Promise((resolve) => {
      calls.push({ cmd, args, opts });
      setTimeout(() => resolve({ stdout: 'killed 1234', stderr: '' }), 25);
    });

  const p = killExternalVpos(fakeExec);
  setTimeout(() => { timerFiredDuringExec = true; }, 5);
  await p;
  assert.equal(timerFiredDuringExec, true, 'el event loop debe seguir respondiendo durante killExternalVpos');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell');
  assert.equal(calls[0].opts.windowsHide, true);

  calls.length = 0;
  await killAllJava(fakeExec);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [
    ['taskkill', ['/F', '/IM', 'javaw.exe']],
    ['taskkill', ['/F', '/IM', 'java.exe']],
  ]);
  assert.ok(calls.every((c) => c.opts.windowsHide === true));
});
