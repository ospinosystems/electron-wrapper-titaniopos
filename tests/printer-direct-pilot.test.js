// node --test tests/printer-direct-pilot.test.js
// Piloto del modo directo: solo enciende la bandera en las cajas de la lista, una vez.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isPilotMatch, applyPrinterDirectPilot } = require('../printer-direct-pilot');

const LIST = [{ store: 'calabozo2', host: 'caja1' }];

test('match: tienda + equipo, sin distinguir mayúsculas ni espacios', () => {
  assert.equal(isPilotMatch('calabozo2', 'caja1', LIST, false), true);
  assert.equal(isPilotMatch(' Calabozo2 ', 'CAJA1', LIST, false), true);
  assert.equal(isPilotMatch('calabozo2', 'caja2', LIST, false), false);
  assert.equal(isPilotMatch('calabozo', 'caja1', LIST, false), false);
  assert.equal(isPilotMatch('', 'caja1', LIST, false), false);
  assert.equal(isPilotMatch('calabozo2', '', LIST, false), false);
  assert.equal(isPilotMatch(null, undefined, LIST, false), false);
});

test('PILOT_ALL enciende en cualquier caja', () => {
  assert.equal(isPilotMatch('otra', 'cajaX', LIST, true), true);
});

function fakeSettings(initial) {
  const state = JSON.parse(JSON.stringify(initial));
  const writes = [];
  return {
    writes,
    readSettings: () => JSON.parse(JSON.stringify(state)),
    writeSettings: (_app, next) => { writes.push(JSON.parse(JSON.stringify(next))); Object.assign(state, next); return next; },
  };
}

test('caja piloto sin decisión previa: escribe enabled=true una sola vez', () => {
  const settings = fakeSettings({ caja: { storeCode: 'calabozo2' }, printerDirectMode: { enabled: null, pilot: '', at: null } });
  const r1 = applyPrinterDirectPilot({}, { settings, hostname: 'CAJA1', list: LIST, all: false });
  assert.equal(r1.changed, true);
  assert.equal(r1.reason, 'pilot');
  assert.equal(settings.writes.length, 1);
  assert.equal(settings.writes[0].printerDirectMode.enabled, true);
  assert.equal(settings.writes[0].printerDirectMode.pilot, 'calabozo2/caja1');
  assert.ok(settings.writes[0].printerDirectMode.at);
  // Segunda pasada: ya decidido, no vuelve a escribir.
  const r2 = applyPrinterDirectPilot({}, { settings, hostname: 'CAJA1', list: LIST, all: false });
  assert.equal(r2.changed, false);
  assert.equal(r2.reason, 'already-set');
  assert.equal(settings.writes.length, 1);
});

test('caja que no es piloto: no escribe nada', () => {
  const settings = fakeSettings({ caja: { storeCode: 'elorza' }, printerDirectMode: { enabled: null } });
  const r = applyPrinterDirectPilot({}, { settings, hostname: 'caja1', list: LIST, all: false });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'not-pilot');
  assert.equal(settings.writes.length, 0);
});

test('decisión previa (false, puesta por soporte) nunca se pisa aunque sea piloto', () => {
  const settings = fakeSettings({ caja: { storeCode: 'calabozo2' }, printerDirectMode: { enabled: false } });
  const r = applyPrinterDirectPilot({}, { settings, hostname: 'caja1', list: LIST, all: false });
  assert.equal(r.changed, false);
  assert.equal(r.enabled, false);
  assert.equal(settings.writes.length, 0);
});

test('error leyendo el settings no lanza', () => {
  const settings = { readSettings: () => { throw new Error('disco'); }, writeSettings: () => {} };
  const r = applyPrinterDirectPilot({}, { settings, hostname: 'caja1', list: LIST, all: false });
  assert.equal(r.changed, false);
  assert.equal(r.reason, 'error');
});
