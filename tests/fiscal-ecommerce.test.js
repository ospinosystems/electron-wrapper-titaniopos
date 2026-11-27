// node --test tests/fiscal-ecommerce.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadFiscalHandlers() {
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain: { handle: () => {} } };
    }
    return origLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve('../fiscal-handlers')];
    return require('../fiscal-handlers');
  } finally {
    Module._load = origLoad;
  }
}

const { generateFiscalContent, sendFiscalInvoice } = loadFiscalHandlers();

const BASE_ECOM_INVOICE = {
  channel: 'ecommerce',
  orderUuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
  orderNumber: '#ED947DB8',
  cashRegisterNumber: '99',
  customerName: 'Alvaro Ospino',
  customerRif: 'V12345678',
  products: [
    { description: 'Taladro Percutor ½"', price: 100, quantity: 1, taxRate: 16 },
  ],
  payments: [
    { code: '20', amountBs: 50 },
    { code: '02', amountBs: 67.5 },
  ],
};

test('generateFiscalContent ecommerce emite i05Caja: DESP | TITANIO STORE #XXXXXXXX y conserva iS*/iR*/ítems/pagos', () => {
  const lines = generateFiscalContent(BASE_ECOM_INVOICE);

  assert.equal(lines[0], 'iS*Alvaro Ospino');
  assert.equal(lines[1], 'iR*V12345678');
  assert.equal(lines[2], 'i05Caja: DESP | TITANIO STORE #ED947DB8');
  assert.ok(lines[2].startsWith('i05Caja:'));
  assert.ok(lines[2].slice(3).length <= 40);
  // No debe emitir i06 cuando ecommerceChannelLine es false
  assert.equal(lines.some((l) => l.startsWith('i06')), false);
  // Conserva ítems y cierres 2XX / 1XX / 199
  assert.ok(lines.some((l) => l.startsWith('!')));
  assert.ok(lines.some((l) => l.startsWith('220')));
  assert.ok(lines.includes('102'));
  assert.equal(lines[lines.length - 1], '199');
});

test('generateFiscalContent ecommerce con ecommerceChannelLine=true emite i05Caja: DESP - <order> y i06Canal: TITANIO STORE #<short>', () => {
  const lines2Arg = generateFiscalContent(
    { ...BASE_ECOM_INVOICE, orderNumber: 'ORD-2026-991' },
    { ecommerceChannelLine: true }
  );
  assert.equal(lines2Arg[2], 'i05Caja: DESP - ORD-2026-991');
  assert.equal(lines2Arg[3], 'i06Canal: TITANIO STORE #ED947DB8');
  assert.ok(lines2Arg[2].slice(3).length <= 40);
  assert.ok(lines2Arg[3].slice(3).length <= 40);

  const lines3Arg = generateFiscalContent(
    { ...BASE_ECOM_INVOICE, orderNumber: 'Órdén Larga Ñ' },
    { enabled: true, raw: 'j211{code}' },
    { ecommerceChannelLine: true }
  );
  assert.equal(lines3Arg[2], 'i05Caja: DESP - Orden Larga N');
  assert.equal(lines3Arg[3], 'i06Canal: TITANIO STORE #ED947DB8');
  assert.ok(lines3Arg.includes('j21106e7ed947db8'));
});

test('generateFiscalContent POS tradicional mantiene i05Caja: <caja> - <orden>', () => {
  const lines = generateFiscalContent({
    ...BASE_ECOM_INVOICE,
    channel: 'pos',
    cashRegisterNumber: '2',
    orderNumber: '1045',
  });
  assert.equal(lines[2], 'i05Caja: 2 - 1045');
});

test('sendFiscalInvoice en modo no fiscal agrega banner sin desplazar ni romper i05Caja:', async () => {
  let sentBody = null;
  const res = await sendFiscalInvoice(
    'http://127.0.0.1:3005',
    BASE_ECOM_INVOICE,
    false,
    null,
    null,
    {
      makeFiscalRequest: async (_url, _method, data) => {
        sentBody = data;
        return { statusCode: 200, data: { status: 'ok', job_id: 'j1' } };
      },
    }
  );
  assert.equal(res.success, true);
  assert.equal(sentBody.parametros[0], 'i04*** NO FISCAL - PRUEBA ***');
  assert.ok(sentBody.parametros.includes('i05Caja: DESP | TITANIO STORE #ED947DB8'));
});

test('fiscal.py extraer_id_caja reconoce i05Caja: en listas, modo no fiscal y cadenas con espacios', () => {
  const pyExe = path.join(__dirname, '..', 'python-embed', 'python.exe');
  if (!fs.existsSync(pyExe)) {
    throw new Error(`python-embed no encontrado en ${pyExe}`);
  }
  const fiscalDir = path.join(__dirname, '..', 'fiscal-server');
  const script = `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(fiscalDir)})
import fiscal

cases = [
    ["i05*** NO FISCAL - PRUEBA ***", "iS*Alvaro", "i05Caja: DESP | TITANIO STORE #ED947DB8", "101", "199"],
    ["i04*** NO FISCAL - PRUEBA ***", "iS*Alvaro", "i05Caja: DESP - #ED947DB8", "i06Canal: TITANIO STORE #ED947DB8", "101", "199"],
    json.dumps(["i05*** NO FISCAL - PRUEBA ***", "i05Caja: DESP | TITANIO STORE #ED947DB8"]),
    "i05*** NO FISCAL - PRUEBA ***\\ni05Caja: DESP | TITANIO STORE #ED947DB8\\n101",
    ["i05Caja:   "],
]
out = [fiscal.extraer_id_caja(c) for c in cases]
print("RESULT_JSON=" + json.dumps(out))
sys.stdout.flush()
os._exit(0)
`;
  const stdout = execFileSync(pyExe, ['-B', '-c', script], { encoding: 'utf8', timeout: 10000 });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT_JSON='));
  assert.ok(line, `Salida inesperada de python: ${stdout}`);
  const results = JSON.parse(line.replace('RESULT_JSON=', ''));

  assert.equal(results[0].id_caja, 'DESP | TITANIO STORE #ED947DB8');
  assert.equal(results[1].id_caja, 'DESP - #ED947DB8');
  assert.equal(results[2].id_caja, 'DESP | TITANIO STORE #ED947DB8');
  assert.equal(results[3].id_caja, 'DESP | TITANIO STORE #ED947DB8');
  assert.equal(results[4].id_caja, null);
});
