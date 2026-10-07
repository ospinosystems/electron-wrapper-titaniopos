// node --test tests/mega-pos-channels.test.js
// Canales primario/secundario del Merchant Server (resolveMegaPosChannels).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveMegaPosChannels, normalizeMegaPos, DEFAULT_MEGA_POS } = require('../titaniopos-settings-file');

const MEGASOFT = { host: 'ssl.megasoftve.com', port: '4772', ssl: true };

test('default: primario Megasoft, sin secundario', () => {
  const r = resolveMegaPosChannels({});
  assert.deepEqual(r.primary, MEGASOFT);
  assert.equal(r.secondary, null);
  assert.equal(r.active, 'primary');
  assert.deepEqual(r.effective, MEGASOFT);
});

test('primario distinto de Megasoft: el secundario implícito es Megasoft', () => {
  const r = resolveMegaPosChannels({ serverHost: '200.71.151.226', serverPort: '24300', ssl: false });
  assert.deepEqual(r.primary, { host: '200.71.151.226', port: '24300', ssl: false });
  assert.deepEqual(r.secondary, MEGASOFT);
  assert.equal(r.active, 'primary');
});

test('activeChannel=secondary usa el secundario (implícito o explícito)', () => {
  const imp = resolveMegaPosChannels({ serverHost: '200.71.151.226', serverPort: '24300', activeChannel: 'secondary' });
  assert.equal(imp.active, 'secondary');
  assert.deepEqual(imp.effective, MEGASOFT);

  const exp = resolveMegaPosChannels({ secondaryHost: 'backup.megasoftve.com', secondaryPort: '', secondarySsl: false, activeChannel: 'secondary' });
  assert.equal(exp.active, 'secondary');
  assert.deepEqual(exp.effective, { host: 'backup.megasoftve.com', port: '4772', ssl: false });
});

test('pedir secundario sin tenerlo cae al primario (nunca a un host vacío)', () => {
  const r = resolveMegaPosChannels({ activeChannel: 'secondary' });
  assert.equal(r.secondary, null);
  assert.equal(r.active, 'primary');
  assert.deepEqual(r.effective, MEGASOFT);
});

test('normalizeMegaPos: valores raros se sanean y los campos nuevos tienen default', () => {
  const n = normalizeMegaPos({ secondaryHost: '  x.com ', secondaryPort: '47a72', secondarySsl: 0, activeChannel: 'loquesea' });
  assert.equal(n.secondaryHost, 'x.com');
  assert.equal(n.secondaryPort, '4772');
  assert.equal(n.secondarySsl, false);
  assert.equal(n.activeChannel, 'primary');
  // Una config vieja (sin los campos) normaliza igual que antes + defaults nuevos.
  const old = normalizeMegaPos({ vtid: 'GTGUARA07' });
  assert.equal(old.serverHost, DEFAULT_MEGA_POS.serverHost);
  assert.equal(old.secondaryHost, '');
  assert.equal(old.activeChannel, 'primary');
});
