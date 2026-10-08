// node --test tests/printer-queue.test.js
// Vaciado de la cola de Windows de la tickera (printer-queue.js), sin PowerShell real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPurgeScript, parsePurgeOutput, purgePrinterQueue } = require('../printer-queue');

test('script: borra todos los trabajos de la impresora y cuenta', () => {
  const s = buildPurgeScript('XP-58');
  assert.match(s, /Get-PrintJob -PrinterName 'XP-58'\)/);
  assert.doesNotMatch(s, /Where-Object/);
  assert.match(s, /Remove-PrintJob -InputObject \$j/);
  assert.match(s, /REMOVED/);
});

test('script: filtro de edad respeta lo recién encolado', () => {
  const s = buildPurgeScript('XP-58', 30);
  assert.match(s, /SubmittedTime -lt \(Get-Date\)\.AddSeconds\(-30\)/);
  assert.doesNotMatch(buildPurgeScript('XP-58', 0), /AddSeconds/);
  assert.doesNotMatch(buildPurgeScript('XP-58', -5), /AddSeconds/);
  assert.match(buildPurgeScript('XP-58', 12.9), /AddSeconds\(-12\)/);
});

test('script: nombre con comilla simple escapado', () => {
  assert.match(buildPurgeScript("Caja 1's XP"), /-PrinterName 'Caja 1''s XP'/);
});

test('parse: lee el conteo o null', () => {
  assert.deepEqual(parsePurgeOutput('REMOVED 3 OF 4\r\n'), { removed: 3, found: 4 });
  assert.equal(parsePurgeOutput('FAILED'), null);
  assert.equal(parsePurgeOutput(''), null);
});

test('purge: sin impresora configurada no corre PowerShell', async () => {
  const r = await purgePrinterQueue('   ', { run: async () => { throw new Error('no debe correr'); } });
  assert.deepEqual(r, { success: true, removed: 0, found: 0, skipped: 'no-printer' });
});

test('purge: resultado de PowerShell y edad pasada al script', async () => {
  let seen = null;
  const run = async (script, timeout) => { seen = { script, timeout }; return { error: null, stdout: 'REMOVED 6 OF 6\n', stderr: '' }; };
  const r = await purgePrinterQueue('XP-58 (copy 1)', { olderThanSeconds: 30, run });
  assert.deepEqual(r, { success: true, removed: 6, found: 6 });
  assert.match(seen.script, /'XP-58 \(copy 1\)'/);
  assert.match(seen.script, /AddSeconds\(-30\)/);
  assert.equal(seen.timeout, 20000);
});

test('purge: error de PowerShell (timeout) no lanza', async () => {
  const run = async () => ({ error: new Error('timeout'), stdout: '', stderr: '' });
  const r = await purgePrinterQueue('XP-58', { run });
  assert.equal(r.success, false);
  assert.equal(r.error, 'timeout');
  const r2 = await purgePrinterQueue('XP-58', { run: async () => { throw new Error('boom'); } });
  assert.equal(r2.success, false);
  assert.equal(r2.error, 'boom');
});

test('purge: salida sin conteo = fallo con el detalle', async () => {
  const run = async () => ({ error: null, stdout: '', stderr: 'Get-PrintJob : no existe' });
  const r = await purgePrinterQueue('XP-58', { run });
  assert.equal(r.success, false);
  assert.equal(r.error, 'Get-PrintJob : no existe');
});
