// node --test tests/despacho-settings-and-raw.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  DEFAULT_SETTINGS,
  normalizeCaja,
  normalizeLabelPrinter,
  normalizeFiscal,
} = require('../titaniopos-settings-file');
const { printRawBufferDirect, validateRawBuffer } = require('../printer-direct');
const { wrapTsplCommand, BITMAP_BYTES } = require('../tspl-label-renderer');

test('titaniopos-settings-file: defaults y normalización de despacho/tspl/ecommerceChannelLine', () => {
  assert.equal(DEFAULT_SETTINGS.caja.stationType, 'register');
  assert.equal(DEFAULT_SETTINGS.labelPrinter.method, 'native');
  assert.equal(DEFAULT_SETTINGS.labelPrinter.variant, 'oficial');
  assert.equal(DEFAULT_SETTINGS.fiscal.ecommerceChannelLine, false);

  assert.equal(normalizeCaja({ stationType: 'dispatch' }).stationType, 'dispatch');
  assert.equal(normalizeCaja({ stationType: 'otro' }).stationType, 'register');

  const lblOficial = normalizeLabelPrinter({ printerName: 'Q86-I', method: 'tspl' });
  assert.equal(lblOficial.method, 'tspl');
  assert.equal(lblOficial.variant, 'oficial');

  const lblN1 = normalizeLabelPrinter({ printerName: 'Q86-I', method: 'tspl', variant: 'n1' });
  assert.equal(lblN1.variant, 'n1');

  const lblV1 = normalizeLabelPrinter({ printerName: 'Q86-I', method: 'tspl', variant: 'v1' });
  assert.equal(lblV1.method, 'tspl');
  assert.equal(lblV1.variant, 'v1');

  assert.equal(normalizeLabelPrinter({ method: 'raro', variant: 'otro' }).method, 'native');
  assert.equal(normalizeLabelPrinter({ method: 'raro', variant: 'otro' }).variant, 'oficial');

  assert.equal(normalizeFiscal({ ecommerceChannelLine: true }).ecommerceChannelLine, true);
  assert.equal(normalizeFiscal({}).ecommerceChannelLine, false);
});

test('validateRawBuffer valida buffers no vacíos y rechaza entradas inválidas', () => {
  assert.equal(validateRawBuffer(null).valid, false);
  assert.equal(validateRawBuffer(Buffer.alloc(0)).valid, false);
  assert.equal(validateRawBuffer('SIZE 58 mm,44 mm').valid, false);

  const okBuf = validateRawBuffer(Buffer.from('CLS\r\n'));
  assert.equal(okBuf.valid, true);
  assert.equal(okBuf.bytes, 5);

  const okUint8 = validateRawBuffer(new Uint8Array([1, 2, 3]));
  assert.equal(okUint8.valid, true);
  assert.equal(okUint8.bytes, 3);
});

test('printRawBufferDirect envía buffer binario exacto SIN insertar ESC @ ni GS V \\x00', async () => {
  const bitmap = Buffer.alloc(BITMAP_BYTES, 0xff);
  bitmap[0] = 0x1b; // byte 0x1B dentro del bitmap no debe confundirse con ESC/POS
  const rawTspl = wrapTsplCommand(bitmap);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspl-raw-test-'));
  let capturedExe = null;
  let capturedArgs = null;
  let tempExistedDuringExec = false;

  const fakeApp = { getPath: () => tempDir };
  const fakeExecFile = (exe, args, _opts, cb) => {
    capturedExe = exe;
    capturedArgs = args;
    const files = fs.readdirSync(tempDir);
    tempExistedDuringExec = files.some((f) => f.endsWith('.bin'));
    cb(null, 'SUCCESS\r\n', '');
  };

  try {
    const res = await printRawBufferDirect(fakeApp, 'Q86-I-Printer', rawTspl, {
      ensureHelper: async () => 'C:\\bin\\TitanioPOSRawPrintHelper.exe',
      execFile: fakeExecFile,
      tempDir,
    });

    assert.equal(res.success, true);
    assert.equal(capturedExe, 'C:\\bin\\TitanioPOSRawPrintHelper.exe');
    assert.equal(capturedArgs[0], 'Q86-I-Printer');
    assert.equal(tempExistedDuringExec, true);

    const sentBytes = Buffer.from(capturedArgs[1], 'base64');
    assert.equal(sentBytes.equals(rawTspl), true);
    // NO debe comenzar con ESC @ (\x1B@) ni terminar con \n\n\n\x1DV\x00
    assert.equal(sentBytes.subarray(0, 2).equals(Buffer.from('\x1B@', 'binary')), false);
    assert.equal(sentBytes.subarray(-4).equals(Buffer.from('\x1DV\x00', 'binary')), false);
    assert.equal(sentBytes.subarray(0, 4).toString('ascii'), 'SIZE');
    assert.equal(sentBytes.subarray(-13).toString('ascii'), '\r\nPRINT 1,1\r\n');
    // Archivo temporal limpiado después de imprimir
    assert.equal(fs.readdirSync(tempDir).length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('print-share: /health reporta tsplReady y POST /print-label acepta format=tspl', async () => {
  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle: () => {} }, BrowserWindow: class {} };
    }
    return origLoad.apply(this, arguments);
  };

  let printShare;
  let preloadSource;
  let printerHandlers;
  try {
    delete require.cache[require.resolve('../print-share')];
    delete require.cache[require.resolve('../printer-handlers')];
    printShare = require('../print-share');
    printerHandlers = require('../printer-handlers');
    preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  } finally {
    Module._load = origLoad;
  }

  assert.match(preloadSource, /printerPrintTsplLabel:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('printer-print-tspl-label',\s*payload\)/);
  const sample = printerHandlers.buildSampleDispatchLabelPayload(new Date(2026, 10, 27));
  assert.equal(sample.kind, 'dispatch_order_label');
  assert.equal(sample.date, '27/11/2026');

  const tmpDocs = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tspl-'));
  const settingsDir = path.join(tmpDocs, 'TitanioPOS-Settings');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'titaniopos-settings.json'),
    JSON.stringify({
      labelPrinter: { printerName: 'Q86-I-Printer', method: 'tspl', variant: 'v1' },
      printShare: { shareEnabled: true, shareLabel: true },
    }),
    'utf8'
  );
  const fakeApp = {
    getPath: (k) => (k === 'documents' ? tmpDocs : tmpDocs),
    getVersion: () => '1.0.275',
  };

  try {
    const health = printShare.buildHealthPayload(fakeApp);
    assert.equal(health.label.tsplReady, true);
    assert.equal(health.label.method, 'tspl');
    assert.equal(health.label.variant, 'v1');

    // Simular HTTP POST /print-label { format: 'tspl', payload }
    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/print-label';
    req.socket = { remoteAddress: '127.0.0.1' };
    let respStatus = null;
    let respBody = null;
    const res = {
      writeHead: (status) => { respStatus = status; },
      end: (raw) => { respBody = JSON.parse(raw); },
    };

    const fakeSent = [];
    const done = new Promise((resolve) => {
      const origEnd = res.end;
      res.end = (raw) => {
        origEnd(raw);
        resolve();
      };
    });

    printShare.handleShareHttpRequest(fakeApp, req, res, {
      renderer: {
        renderDispatchTsplBuffers: async (payload, opts) => {
          assert.equal(opts.variant, 'v1');
          assert.equal(payload.order_code, '#ED947DB8');
          return [Buffer.from('TSPL-FAKE-1'), Buffer.from('TSPL-FAKE-2')];
        },
      },
      printRawBufferDirect: async (_app, printer, buf) => {
        fakeSent.push({ printer, buf: buf.toString('ascii') });
        return { success: true };
      },
    });

    req.emit('data', JSON.stringify({
      format: 'tspl',
      payload: { kind: 'dispatch_order_label', order_code: '#ED947DB8', package_total: 2 },
    }));
    req.emit('end');
    await done;

    assert.equal(respStatus, 200);
    assert.equal(respBody.success, true);
    assert.equal(respBody.printed, 2);
    assert.equal(respBody.variant, 'v1');
    assert.deepEqual(fakeSent, [
      { printer: 'Q86-I-Printer', buf: 'TSPL-FAKE-1' },
      { printer: 'Q86-I-Printer', buf: 'TSPL-FAKE-2' },
    ]);
  } finally {
    fs.rmSync(tmpDocs, { recursive: true, force: true });
  }
});
