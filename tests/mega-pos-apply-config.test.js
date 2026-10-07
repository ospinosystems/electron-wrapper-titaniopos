// node --test tests/mega-pos-apply-config.test.js
// applyConfigToIni: lo que el settings de la caja escribe en vposconf.ini.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _internals: { applyConfigToIni } } = require('../mega-pos-manager');
const { normalizeMegaPos } = require('../titaniopos-settings-file');

const INI = [
  '[server]', 'host=200.71.151.226', 'port=24300', '',
  '[SeqNum]', 'seqnum=1', '',
  '[vtid]', 'vtid=GTGUARA07', 'id=0007', '',
  '[SSL]', 'active=0', '',
].join('\r\n');

const fixture = () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'vpos-apply-'));
  fs.mkdirSync(path.join(runtime, 'conf'));
  fs.writeFileSync(path.join(runtime, 'conf', 'vposconf.ini'), INI);
  return runtime;
};
const section = (runtime, name) => {
  const txt = fs.readFileSync(path.join(runtime, 'conf', 'vposconf.ini'), 'utf8');
  const m = txt.match(new RegExp(`\\[${name}\\]\\n([^[]*)`, 'i'));
  return Object.fromEntries(m[1].trim().split('\n').filter(Boolean).map((l) => l.split('=')));
};

test('escribe host/puerto/ssl y la identidad de la caja', () => {
  const r = fixture();
  applyConfigToIni(r, normalizeMegaPos({ serverHost: 'ssl.megasoftve.com', serverPort: '4772', ssl: true, vtid: 'GTMARA01', id: '0001' }));
  assert.deepEqual(section(r, 'server'), { host: 'ssl.megasoftve.com', port: '4772' });
  assert.deepEqual(section(r, 'SSL'), { active: '1' });
  assert.deepEqual(section(r, 'vtid'), { vtid: 'GTMARA01', id: '0001' });
  fs.rmSync(r, { recursive: true, force: true });
});

test('VTID vacío en el settings SÍ limpia el ini (antes quedaba el terminal anterior)', () => {
  const r = fixture();
  applyConfigToIni(r, normalizeMegaPos({ vtid: '', id: '' }));
  assert.deepEqual(section(r, 'vtid'), { vtid: '', id: '' });
  // host/puerto nunca quedan vacíos: normalizeMegaPos cae al Merchant por defecto.
  assert.deepEqual(section(r, 'server'), { host: 'ssl.megasoftve.com', port: '4772' });
  fs.rmSync(r, { recursive: true, force: true });
});

test('no toca otras secciones (SeqNum queda igual)', () => {
  const r = fixture();
  applyConfigToIni(r, normalizeMegaPos({ vtid: 'X' }));
  assert.deepEqual(section(r, 'SeqNum'), { seqnum: '1' });
  fs.rmSync(r, { recursive: true, force: true });
});
