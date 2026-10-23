// node --test tests/customer-display.test.js
// Pantalla del cliente: helpers puros (origen de la vista y elección del monitor).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { originFromUrl, pickExternalDisplay } = require('../customer-display');

test('originFromUrl: solo http(s), sin ruta', () => {
  assert.equal(originFromUrl('http://127.0.0.1:3010/checkout/calabozo2?x=1'), 'http://127.0.0.1:3010');
  assert.equal(originFromUrl('https://frontend.titanio-pos.com/checkout'), 'https://frontend.titanio-pos.com');
  assert.equal(originFromUrl('data:text/html,<h1>splash</h1>'), null);
  assert.equal(originFromUrl('tpos://retry'), null);
  assert.equal(originFromUrl('about:blank'), null);
  assert.equal(originFromUrl(''), null);
  assert.equal(originFromUrl(undefined), null);
  assert.equal(originFromUrl('no es url'), null);
});

test('pickExternalDisplay: el primero que no es el principal', () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1366, height: 768 } };
  const second = { id: 2, bounds: { x: 1366, y: 0, width: 1024, height: 600 } };
  const third = { id: 3, bounds: { x: 2390, y: 0, width: 800, height: 600 } };
  assert.equal(pickExternalDisplay([primary], primary), null);
  assert.equal(pickExternalDisplay([primary, second], primary), second);
  assert.equal(pickExternalDisplay([second, primary, third], primary), second);
  assert.equal(pickExternalDisplay([], primary), null);
  assert.equal(pickExternalDisplay(undefined, primary), null);
});
