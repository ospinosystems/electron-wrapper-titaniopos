// node --test tests/tspl-label-renderer.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  TARGET_W,
  TARGET_H,
  ROW_BYTES,
  BITMAP_BYTES,
  DEFAULT_THRESHOLD,
  buildLabelHtml,
  rgbaToTsplBitmap,
  wrapTsplCommand,
  normalizeDispatchPayload,
  expandPackagePayloads,
  encodeQrMatrixPure,
  generateQrSvg,
} = require('../tspl-label-renderer');

function makeRgbaBuffer(fillR = 255, fillG = 255, fillB = 255, fillA = 255) {
  const buf = Buffer.alloc(TARGET_W * TARGET_H * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = fillR;
    buf[i + 1] = fillG;
    buf[i + 2] = fillB;
    buf[i + 3] = fillA;
  }
  return buf;
}

function setPixel(buf, x, y, r, g, b, a = 255) {
  const idx = (y * TARGET_W + x) * 4;
  buf[idx] = r;
  buf[idx + 1] = g;
  buf[idx + 2] = b;
  buf[idx + 3] = a;
}

test('rgbaToTsplBitmap genera exactamente 58 * 352 = 20416 bytes', () => {
  const white = makeRgbaBuffer(255, 255, 255, 255);
  const bitmap = rgbaToTsplBitmap(white, TARGET_W, TARGET_H);
  assert.equal(bitmap.length, 58 * 352);
  assert.equal(bitmap.length, BITMAP_BYTES);
  assert.equal(bitmap.every((b) => b === 0xff), true);
});

test('rgbaToTsplBitmap respeta empaquetado MSB 1-bit y umbral 160', () => {
  assert.equal(DEFAULT_THRESHOLD, 160);
  const buf = makeRgbaBuffer(255, 255, 255, 255);
  // x=0,y=0 gris 159 (< 160) -> bit 7 en 0 -> byte[0] = 0x7F
  setPixel(buf, 0, 0, 159, 159, 159, 255);
  // x=1,y=0 gris 160 (>= 160) -> blanco (bit 6 queda en 1)
  setPixel(buf, 1, 0, 160, 160, 160, 255);
  // x=7,y=0 negro (0) -> bit 0 en 0 -> byte[0] = 0x7E
  setPixel(buf, 7, 0, 0, 0, 0, 255);
  // x=8,y=0 negro (0) -> byte[1] = 0x7F
  setPixel(buf, 8, 0, 0, 0, 0, 255);
  // Píxel transparente (0,0,0,0) debe componerse sobre blanco -> queda blanco (1)
  setPixel(buf, 2, 0, 0, 0, 0, 0);

  const bitmap = rgbaToTsplBitmap(buf, TARGET_W, TARGET_H);
  assert.equal(bitmap[0], 0x7e);
  assert.equal(bitmap[1], 0x7f);
  assert.equal(bitmap[ROW_BYTES], 0xff);
});

test('rgbaToTsplBitmap soporta formato BGRA de Electron NativeImage.toBitmap()', () => {
  const buf = makeRgbaBuffer(255, 255, 255, 255);
  // En BGRA: B=255, G=0, R=0 -> azul puro (lum = 0.114 * 255 = 29 < 160 -> negro)
  setPixel(buf, 0, 0, 255, 0, 0, 255);
  // En BGRA: B=0, G=255, R=255 -> amarillo (lum = 0.886 * 255 = 225.9 >= 160 -> blanco)
  setPixel(buf, 1, 0, 0, 255, 255, 255);

  const bitmap = rgbaToTsplBitmap(buf, TARGET_W, TARGET_H, { format: 'bgra' });
  assert.equal(bitmap[0], 0x7f);
});

test('wrapTsplCommand envuelve cabecera y cierre TSPL exactos', () => {
  const bitmap = Buffer.alloc(BITMAP_BYTES, 0xff);
  const cmd = wrapTsplCommand(bitmap);
  const expectedHeader =
    'SIZE 58 mm,44 mm\r\n' +
    'GAP 2 mm,0 mm\r\n' +
    'SPEED 2\r\n' +
    'DENSITY 9\r\n' +
    'DIRECTION 0\r\n' +
    'REFERENCE 0,0\r\n' +
    'OFFSET 0 mm\r\n' +
    'CLS\r\n' +
    'BITMAP 0,0,58,352,0,';
  const expectedTail = '\r\nPRINT 1,1\r\n';

  assert.equal(cmd.subarray(0, expectedHeader.length).toString('ascii'), expectedHeader);
  assert.equal(cmd.subarray(expectedHeader.length, expectedHeader.length + BITMAP_BYTES).equals(bitmap), true);
  assert.equal(cmd.subarray(expectedHeader.length + BITMAP_BYTES).toString('ascii'), expectedTail);
  assert.throws(() => wrapTsplCommand(Buffer.alloc(100)), /20416/);
});

test('buildLabelHtml genera N1 y V1 válidos y escapa cualquier XSS', () => {
  const payload = {
    kind: 'dispatch_order_label',
    order_uuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    order_code: '#ED947DB8<script>',
    verify_url: 'https://ecommerce.titanio-pos.com/v/5cdc72c6-b481-4d80-a934-06e7ed947db8',
    shipping_mode: 'DELIVERY',
    date: '27/11/2026',
    customer_name: '<img src=x onerror=alert(1)> & "Alvaro"',
    customer_phone: '0414-555-0192',
    address_line: 'Av. Bolívar Norte, Residencias Las Acacias, Torre B, Piso 8, Apartamento 8-C, Valencia',
    store_name: 'Guacara',
    items_count: 3,
    paid_label: 'PAGADO · Delivery',
    package_total: 2,
    package_index: 1,
  };

  const n1 = buildLabelHtml(payload, { variant: 'n1' });
  assert.match(n1, /data-variant="n1"/);
  assert.match(n1, /Validar envío/);
  assert.match(n1, /TITANIO STORE/);
  assert.match(n1, /PAQUETE 1\/2 · 27\/11\/2026/);
  assert.match(n1, /-webkit-font-smoothing: none/);
  assert.match(n1, /… \(ver QR\)/);
  assert.match(n1, /Guacara · 3 uds\./);
  assert.match(n1, /<svg class="qr-svg"/);
  assert.equal(n1.includes('<script>'), false);
  assert.equal(n1.includes('<img '), false);
  assert.match(n1, /&lt;script&gt;/);
  assert.match(n1, /&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Alvaro&quot;/);

  const v1 = buildLabelHtml(payload, { variant: 'v1' });
  assert.match(v1, /data-variant="v1"/);
  assert.match(v1, /class="v1-top"/);
  assert.match(v1, /PAQUETE 1\/2/);
  assert.equal(v1.includes('<script>'), false);
  assert.equal(v1.includes('<img '), false);
});

test('expandPackagePayloads expande bucle 1..N (tope 20) si package_index es null', () => {
  const three = expandPackagePayloads({
    order_uuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    package_total: 3,
    package_index: null,
  });
  assert.deepEqual(
    three.map((x) => `${x.package_index}/${x.package_total}`),
    ['1/3', '2/3', '3/3']
  );

  const capped = expandPackagePayloads({ order_uuid: 'abc', package_total: 50, package_index: null });
  assert.equal(capped.length, 20);
  assert.equal(capped[19].package_index, 20);
  assert.equal(capped[19].package_total, 20);

  const single = expandPackagePayloads({ order_uuid: 'abc', package_total: 5, package_index: 3 });
  assert.equal(single.length, 1);
  assert.equal(single[0].package_index, 3);
  assert.equal(single[0].package_total, 5);
});

test('encodeQrMatrixPure y generateQrSvg producen matriz y SVG QR válidos', () => {
  const url = 'https://ecommerce.titanio-pos.com/v/5cdc72c6-b481-4d80-a934-06e7ed947db8';
  const m = encodeQrMatrixPure(url);
  assert.ok(m.size >= 21 && (m.size - 17) % 4 === 0);
  // Esquina superior izquierda del patrón buscador 7x7: borde negro en (0,0) y centro negro en (3,3)
  assert.equal(m.data[0], 1);
  assert.equal(m.data[3 * m.size + 3], 1);
  assert.equal(m.data[1 * m.size + 1], 0);
  const svg = generateQrSvg(url);
  assert.match(svg, /^<svg class="qr-svg"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
});

test('normalizeDispatchPayload y expandPackagePayloads aceptan snake_case (backend) y camelCase (POS)', () => {
  const snake = normalizeDispatchPayload({
    order_uuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    order_code: '#ED947DB8',
    verify_url: 'https://ecommerce.titanio-pos.com/v/5cdc72c6-b481-4d80-a934-06e7ed947db8',
    shipping_mode: 'DELIVERY',
    date: '27/11/2026',
    customer_name: 'Alvaro Ospino',
    customer_phone: '0414-555-0192',
    address_line: 'Urb. Loma Linda, Calle 4',
    store_name: 'Guacara',
    items_count: 3,
    paid_label: 'PAGADO · Delivery',
    package_total: 2,
    package_index: 2,
  });

  const camel = normalizeDispatchPayload({
    orderUuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    orderNumber: '#ED947DB8',
    verifyUrl: 'https://ecommerce.titanio-pos.com/v/5cdc72c6-b481-4d80-a934-06e7ed947db8',
    shippingType: 'delivery',
    shippingLabel: 'DELIVERY',
    dateText: '27/11/2026',
    receiverName: 'Alvaro Ospino',
    receiverPhone: '0414-555-0192',
    addressText: 'Urb. Loma Linda, Calle 4',
    storeName: 'Guacara',
    itemsCount: 3,
    paidLabel: 'PAGADO · Delivery',
    packageTotal: 2,
    packageIndex: 2,
  });

  assert.deepEqual(camel, snake);

  const pickup = normalizeDispatchPayload({
    orderUuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    order_number: '#ED947DB8',
    shippingType: 'pickup',
    customerName: 'María Pérez',
    customerPhone: '0412-000-0001',
    packageTotal: 2,
  });
  assert.equal(pickup.shipping_mode, 'RETIRO');
  assert.equal(pickup.order_code, '#ED947DB8');
  assert.equal(pickup.customer_name, 'María Pérez');
  assert.equal(pickup.customer_phone, '0412-000-0001');

  const expandedCamel = expandPackagePayloads({
    orderUuid: '5cdc72c6-b481-4d80-a934-06e7ed947db8',
    orderNumber: '#ED947DB8',
    packageTotal: 2,
    packageIndex: null,
  });
  assert.deepEqual(
    expandedCamel.map((x) => `${x.package_index}/${x.package_total}`),
    ['1/2', '2/2']
  );

  const html = buildLabelHtml(camel, { variant: 'n1' });
  assert.match(html, /#ED947DB8/);
  assert.match(html, /PAQUETE 2\/2 · 27\/11\/2026/);
  assert.match(html, /Alvaro Ospino/);
  assert.match(html, /Guacara · 3 uds\./);
});
