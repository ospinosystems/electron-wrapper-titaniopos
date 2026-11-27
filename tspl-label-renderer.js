/**
 * Renderizador nativo 58 × 44 mm TSPL (Q86-I-Printer, 203 DPI = 464 × 352 dots)
 * para etiquetas de despacho de Titanio Store.
 *
 * Funciones puras exportadas (sin dependencia de Electron, Playwright ni Sharp):
 *   - buildLabelHtml(payload, options)
 *   - rgbaToTsplBitmap(pixelBuffer, width, height, options)
 *   - wrapTsplCommand(bitmapBuffer)
 *   - expandPackagePayloads(payload)
 *   - generateQrSvg(url)
 */

const fs = require('fs');
const path = require('path');

const TARGET_W = 464;
const TARGET_H = 352;
const ROW_BYTES = TARGET_W / 8; // 58
const BITMAP_BYTES = ROW_BYTES * TARGET_H; // 20416
const DEFAULT_THRESHOLD = 160;
const MAX_PACKAGES = 20;
// 58 mm a 96 DPI = 219.2126 CSS px -> factor 464 / 219.2126 = 203.2 / 96
const ZOOM_FACTOR = 203.2 / 96;

const BACK_CARD_D =
  'M36.991,30.628 L57.554,27.002 A11.6,11.6 0 0 1 70.992,36.411 L74.618,56.974 A11.6,11.6 0 0 1 65.209,70.412 L44.646,74.038 A11.6,11.6 0 0 1 31.208,64.629 L27.582,44.066 A11.6,11.6 0 0 1 36.991,30.628 Z';
const FRONT_CARD_D =
  'M46.46,35.44 L67.34,35.44 A11.6,11.6 0 0 1 78.94,47.04 L78.94,67.92 A11.6,11.6 0 0 1 67.34,79.52 L46.46,79.52 A11.6,11.6 0 0 1 34.86,67.92 L34.86,47.04 A11.6,11.6 0 0 1 46.46,35.44 Z';
const LETTER_T_D =
  'M66.441,47.736 C66.34,48.345 65.325,54.739 65.223,55.145 C65.223,55.349 65.02,55.45 64.918,55.45 C64.107,55.45 62.279,55.247 61.569,55.247 C61.264,55.247 61.163,55.145 61.061,54.841 C60.757,53.522 59.742,52.71 58.524,52.811 C57.204,52.811 56.291,53.725 56.088,55.044 L56.088,65.904 C56.088,68.442 57.509,69.863 59.945,69.863 C60.96,69.863 62.381,69.66 62.99,69.254 L62.99,75.75 C62.077,76.257 60.453,76.562 58.93,76.562 C52.637,76.562 48.882,72.603 48.882,66.006 L48.882,58.799 C48.882,57.48 48.882,56.059 48.78,54.739 C48.78,54.13 48.678,53.521 48.374,52.912 C47.867,51.796 46.446,51.288 45.329,51.593 C43.908,51.999 43.807,52.202 42.589,53.014 C42.284,53.217 41.878,53.724 41.472,53.318 C41.168,53.014 41.472,52.506 41.675,52.202 C43.299,49.36 45.634,47.837 48.78,47.431 L48.78,40.022 L55.987,40.022 L55.987,47.33 C57.509,47.33 59.235,47.431 60.757,47.431 C63.599,47.533 66.035,47.533 66.238,47.533 Q66.543,47.431 66.441,47.736 Z M70.602,55.45 L67.355,55.552 Q67.253,55.552 67.253,55.45 L68.471,47.533 C68.471,47.533 68.471,47.431 68.572,47.431 L70.399,47.431 C70.399,47.431 70.501,47.431 70.501,47.533 L70.602,55.45 Q70.704,55.45 70.602,55.45 Z';

let cachedFontBase64 = null;
function loadFontBase64() {
  if (cachedFontBase64 !== null) return cachedFontBase64;
  try {
    const fontPath = path.join(__dirname, 'assets', 'fonts', 'pjs-0.woff2');
    if (fs.existsSync(fontPath)) {
      cachedFontBase64 = fs.readFileSync(fontPath).toString('base64');
      return cachedFontBase64;
    }
  } catch (_) {
    // Fallback al stack de fuentes del sistema
  }
  cachedFontBase64 = '';
  return cachedFontBase64;
}

// ==================== GENERADOR QR PURO EN JS (FALLBACK) ====================
// Soporta modo Byte UTF-8 con ECC nivel L (versiones 1..10, hasta 271 bytes)
// para funcionar incluso sin el paquete opcional `qrcode`.
const QR_GF_EXP = new Uint8Array(512);
const QR_GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_GF_EXP[i] = x;
    QR_GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) QR_GF_EXP[i] = QR_GF_EXP[i - 255];
})();

function qrGfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return QR_GF_EXP[QR_GF_LOG[a] + QR_GF_LOG[b]];
}

function qrRsGeneratorPoly(ecCount) {
  let poly = [1];
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = QR_GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= qrGfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function qrRsCompute(data, ecCount) {
  const gen = qrRsGeneratorPoly(ecCount);
  const res = new Uint8Array(data.length + ecCount);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        res[i + j] ^= qrGfMul(gen[j], coef);
      }
    }
  }
  return res.slice(data.length);
}

// Tabla EC nivel L para versiones 1..10: [totalCodewords, ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
const QR_EC_L_TABLE = [
  null,
  [26, 7, 1, 19, 0, 0],
  [44, 10, 1, 34, 0, 0],
  [70, 15, 1, 55, 0, 0],
  [100, 20, 1, 80, 0, 0],
  [134, 26, 1, 108, 0, 0],
  [172, 18, 2, 68, 0, 0],
  [196, 20, 2, 78, 0, 0],
  [242, 24, 2, 97, 0, 0],
  [292, 30, 2, 116, 0, 0],
  [346, 18, 2, 68, 2, 69],
];

const QR_ALIGN_POS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function qrFormatBits(maskPattern) {
  // ECC Level L = 01 (bits 01 + 3-bit mask)
  const data = (0b01 << 3) | (maskPattern & 7);
  let d = data << 10;
  const gen = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((d >> i) & 1) d ^= gen << (i - 10);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function qrVersionBits(version) {
  let d = version << 12;
  const gen = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((d >> i) & 1) d ^= gen << (i - 12);
  }
  return (version << 12) | d;
}

function encodeQrMatrixPure(text) {
  const bytes = Buffer.from(String(text || ''), 'utf8');
  let version = 1;
  while (version <= 10) {
    const [, , g1b, g1d, g2b, g2d] = QR_EC_L_TABLE[version];
    const dataBytes = g1b * g1d + g2b * g2d;
    const countBits = version < 10 ? 8 : 16;
    const neededBits = 4 + countBits + bytes.length * 8;
    if (neededBits <= dataBytes * 8) break;
    version++;
  }
  if (version > 10) {
    throw new Error('URL demasiado larga para generador QR ligero');
  }

  const [totalCw, ecPerBlock, g1b, g1d, g2b, g2d] = QR_EC_L_TABLE[version];
  const totalDataCw = g1b * g1d + g2b * g2d;
  const bitBuf = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bitBuf.push((val >> i) & 1);
  };

  pushBits(0b0100, 4); // Modo Byte
  pushBits(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = totalDataCw * 8;
  const term = Math.min(4, maxBits - bitBuf.length);
  for (let i = 0; i < term; i++) bitBuf.push(0);
  while (bitBuf.length % 8 !== 0) bitBuf.push(0);
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bitBuf.length < maxBits) {
    pushBits(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataCw = new Uint8Array(totalDataCw);
  for (let i = 0; i < totalDataCw; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bitBuf[i * 8 + b];
    dataCw[i] = v;
  }

  const blocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i++) {
    const blk = dataCw.slice(offset, offset + g1d);
    blocks.push(blk);
    ecBlocks.push(qrRsCompute(blk, ecPerBlock));
    offset += g1d;
  }
  for (let i = 0; i < g2b; i++) {
    const blk = dataCw.slice(offset, offset + g2d);
    blocks.push(blk);
    ecBlocks.push(qrRsCompute(blk, ecPerBlock));
    offset += g2d;
  }

  const finalCw = [];
  const maxDataLen = Math.max(g1d, g2d);
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of blocks) {
      if (i < blk.length) finalCw.push(blk[i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const ec of ecBlocks) finalCw.push(ec[i]);
  }

  const size = version * 4 + 17;
  const buildWithMask = (mask) => {
    const modules = new Int8Array(size * size).fill(-1);
    const isFunc = new Uint8Array(size * size);
    const set = (r, c, val, fn = true) => {
      if (r < 0 || r >= size || c < 0 || c >= size) return;
      modules[r * size + c] = val ? 1 : 0;
      if (fn) isFunc[r * size + c] = 1;
    };

    const drawFinder = (r0, c0) => {
      for (let dr = -1; dr <= 7; dr++) {
        for (let dc = -1; dc <= 7; dc++) {
          const r = r0 + dr;
          const c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const on =
            dr >= 0 &&
            dr <= 6 &&
            dc >= 0 &&
            dc <= 6 &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          set(r, c, on, true);
        }
      }
    };
    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      set(6, i, i % 2 === 0, true);
      set(i, 6, i % 2 === 0, true);
    }

    const align = QR_ALIGN_POS[version];
    for (const r of align) {
      for (const c of align) {
        if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            set(r + dr, c + dc, on, true);
          }
        }
      }
    }

    set(4 * version + 9, 8, true, true);

    // Reservar formato
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) {
        isFunc[8 * size + i] = 1;
        isFunc[i * size + 8] = 1;
      }
    }
    for (let i = size - 8; i < size; i++) {
      isFunc[8 * size + i] = 1;
      isFunc[i * size + 8] = 1;
    }

    if (version >= 7) {
      const vb = qrVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = ((vb >> i) & 1) === 1;
        const a = Math.floor(i / 3);
        const b = (i % 3) + size - 11;
        set(a, b, bit, true);
        set(b, a, bit, true);
      }
    }

    // Colocar datos en zig-zag
    let bitIndex = 0;
    const totalBits = finalCw.length * 8;
    let up = true;
    for (let col = size - 1; col >= 1; col -= 2) {
      if (col === 6) col--;
      for (let step = 0; step < size; step++) {
        const r = up ? size - 1 - step : step;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (isFunc[r * size + c]) continue;
          let bit = 0;
          if (bitIndex < totalBits) {
            bit = (finalCw[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          let inv = false;
          if (mask === 0) inv = (r + c) % 2 === 0;
          else if (mask === 1) inv = r % 2 === 0;
          else if (mask === 2) inv = c % 3 === 0;
          else if (mask === 3) inv = (r + c) % 3 === 0;
          else if (mask === 4) inv = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
          else if (mask === 5) inv = ((r * c) % 2) + ((r * c) % 3) === 0;
          else if (mask === 6) inv = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
          else if (mask === 7) inv = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
          modules[r * size + c] = bit ^ (inv ? 1 : 0);
        }
      }
      up = !up;
    }

    const fb = qrFormatBits(mask);
    for (let i = 0; i < 15; i++) {
      const bit = ((fb >> i) & 1) === 1;
      if (i < 6) set(i, 8, bit, true);
      else if (i < 8) set(i + 1, 8, bit, true);
      else set(size - 15 + i, 8, bit, true);

      if (i < 8) set(8, size - 1 - i, bit, true);
      else if (i < 9) set(8, 15 - i, bit, true);
      else set(8, 14 - i, bit, true);
    }
    return modules;
  };

  const penalty = (m) => {
    let score = 0;
    for (let r = 0; r < size; r++) {
      let runColor = m[r * size];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        const cur = m[r * size + c];
        if (cur === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score += 1;
        } else {
          runColor = cur;
          runLen = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let runColor = m[c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        const cur = m[r * size + c];
        if (cur === runColor) {
          runLen++;
          if (runLen === 5) score += 3;
          else if (runLen > 5) score += 1;
        } else {
          runColor = cur;
          runLen = 1;
        }
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r * size + c];
        if (v === m[r * size + c + 1] && v === m[(r + 1) * size + c] && v === m[(r + 1) * size + c + 1]) {
          score += 3;
        }
      }
    }
    let dark = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) dark++;
    const pct = (dark * 100) / m.length;
    const prev5 = Math.floor(Math.abs(pct - 50) / 5);
    score += prev5 * 10;
    return score;
  };

  let bestModules = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = buildWithMask(mask);
    const s = penalty(m);
    if (s < bestScore) {
      bestScore = s;
      bestModules = m;
    }
  }
  return { size, data: bestModules, totalCw };
}

function getQrMatrix(url) {
  try {
    const QRCode = require('qrcode');
    const qr = QRCode.create(String(url || ''), { errorCorrectionLevel: 'L' });
    return { size: qr.modules.size, data: qr.modules.data };
  } catch (_) {
    return encodeQrMatrixPure(url);
  }
}

function generateQrSvg(url) {
  const { size, data } = getQrMatrix(url);
  const cmds = [];
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (data[y * size + x]) {
        const startX = x;
        while (x < size && data[y * size + x]) x++;
        cmds.push(`M${startX} ${y}h${x - startX}v1h-${x - startX}z`);
      } else {
        x++;
      }
    }
  }
  const qz = 3;
  const total = size + qz * 2;
  return `<svg class="qr-svg" xmlns="http://www.w3.org/2000/svg" viewBox="-${qz} -${qz} ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR validación"><rect x="-${qz}" y="-${qz}" width="${total}" height="${total}" fill="#FFFFFF"/><path fill="#000000" d="${cmds.join('')}"/></svg>`;
}

function pilaMonoSvg(cls = 'pila-mark') {
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="24.5 24.5 56.5 56.5" aria-hidden="true"><path fill="#FFFFFF" stroke="#000000" stroke-width="3.4" stroke-linejoin="round" d="${BACK_CARD_D}"/><path fill="#000000" d="${FRONT_CARD_D}"/><path fill="#FFFFFF" d="${LETTER_T_D}"/></svg>`;
}

function pilaInvertedSvg(cls = 'pila-mark') {
  return `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="24.5 24.5 56.5 56.5" aria-hidden="true"><path fill="#000000" stroke="#FFFFFF" stroke-width="3.2" stroke-linejoin="round" d="${BACK_CARD_D}"/><path fill="#FFFFFF" d="${FRONT_CARD_D}"/><path fill="#000000" d="${LETTER_T_D}"/></svg>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTodayDdMmYyyy(now = new Date()) {
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function truncateAddressTwoLines(addr, maxChars = 60) {
  const clean = String(addr || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const suffix = '… (ver QR)';
  const limit = Math.max(12, maxChars - suffix.length);
  let cut = clean.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > limit * 0.6) {
    cut = cut.slice(0, lastSpace);
  }
  return `${cut.trimEnd()}${suffix}`;
}

function normalizeDispatchPayload(raw = {}, packageOverride = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const orderUuid = String(src.order_uuid || '').trim();
  const fallbackShort = orderUuid
    ? `#${orderUuid.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase()}`
    : '#00000000';
  const orderCode = String(src.order_code || fallbackShort).trim();
  const verifyUrl = String(
    src.verify_url ||
      (orderUuid
        ? `https://ecommerce.titanio-pos.com/v/${encodeURIComponent(orderUuid)}`
        : 'https://ecommerce.titanio-pos.com')
  ).trim();
  const rawMode = String(src.shipping_mode || 'DELIVERY').trim().toUpperCase();
  const shippingMode = rawMode === 'PICKUP' ? 'RETIRO' : rawMode || 'DELIVERY';
  const packageTotal = Math.min(MAX_PACKAGES, Math.max(1, Math.trunc(Number(src.package_total) || 1)));

  let packageIndex = null;
  if (packageOverride != null && Number.isFinite(Number(packageOverride))) {
    packageIndex = Math.min(packageTotal, Math.max(1, Math.trunc(Number(packageOverride))));
  } else if (src.package_index != null && src.package_index !== '' && Number.isFinite(Number(src.package_index))) {
    packageIndex = Math.min(packageTotal, Math.max(1, Math.trunc(Number(src.package_index))));
  }

  return {
    kind: 'dispatch_order_label',
    order_uuid: orderUuid,
    order_code: orderCode,
    verify_url: verifyUrl,
    shipping_mode: shippingMode,
    date: String(src.date || formatTodayDdMmYyyy()).trim(),
    customer_name: String(src.customer_name || 'Cliente').trim(),
    customer_phone: String(src.customer_phone || '').trim(),
    address_line: truncateAddressTwoLines(src.address_line || ''),
    store_name: String(src.store_name || 'Titanio').trim(),
    items_count: Math.max(0, Math.trunc(Number(src.items_count) || 0)),
    paid_label: String(src.paid_label || 'PAGADO').trim(),
    package_total: packageTotal,
    package_index: packageIndex ?? 1,
  };
}

function expandPackagePayloads(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.package_index != null && src.package_index !== '' && Number.isFinite(Number(src.package_index))) {
    return [normalizeDispatchPayload(src)];
  }
  const total = Math.min(MAX_PACKAGES, Math.max(1, Math.trunc(Number(src.package_total) || 1)));
  const out = [];
  for (let i = 1; i <= total; i++) {
    out.push(normalizeDispatchPayload(src, i));
  }
  return out;
}

function buildSharedCss() {
  const fontBase64 = loadFontBase64();
  const fontFace = fontBase64
    ? `@font-face {
    font-family: "Plus Jakarta Sans";
    src: url("data:font/woff2;base64,${fontBase64}") format("woff2");
    font-weight: 200 800;
    font-style: normal;
    font-display: block;
  }`
    : '';

  return `${fontFace}
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: #FFFFFF;
  }

  .qr-svg {
    width: 100%;
    height: 100%;
    display: block;
  }

  /* ==================== N1: QR A LA IZQUIERDA (SCAN-FIRST) ==================== */
  .label-sheet.n1 {
    width: 58mm;
    height: 44mm;
    padding: 1.8mm 2.0mm;
    background: #FFFFFF;
    color: #000000;
    font-family: "Plus Jakarta Sans", "Segoe UI", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
    overflow: hidden;
  }
  .label-safe {
    width: 54mm;
    height: 40.4mm;
    background: #FFFFFF;
    color: #000000;
    overflow: hidden;
  }
  .qr-frame {
    width: 14.2mm;
    height: 14.2mm;
    background: #FFFFFF;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .pill-dark {
    background: #000000;
    color: #FFFFFF;
    border-radius: 0.9mm;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.04em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .box-2px {
    border: 2px solid #000000;
    border-radius: 0.65mm;
    background: #FFFFFF;
    color: #000000;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .n1-safe {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .n1-main {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
    gap: 1.3mm;
    padding-bottom: 0.7mm;
    overflow: hidden;
  }
  .n1-left {
    width: 15.4mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.7mm;
    flex-shrink: 0;
  }
  .n1-qr-cap {
    font-size: 7.0pt;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .n1-right {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .n1-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.7mm;
  }
  .n1-brand {
    display: flex;
    align-items: center;
    gap: 0.65mm;
    font-size: 7.0pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .n1-pila {
    width: 3.6mm;
    height: 3.6mm;
    display: block;
  }
  .n1-pill {
    padding: 0.55mm 0.95mm;
    font-size: 7.0pt;
    letter-spacing: 0.01em;
  }
  .n1-order-block {
    border-bottom: 2px solid #000000;
    padding-bottom: 0.65mm;
    display: flex;
    flex-direction: column;
    gap: 0.45mm;
  }
  .n1-order {
    font-size: 14.0pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.025em;
  }
  .n1-pkg-date {
    font-size: 7.0pt;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .n1-dest {
    display: flex;
    flex-direction: column;
    gap: 0.35mm;
    overflow: hidden;
  }
  .n1-name {
    font-size: 8.2pt;
    font-weight: 800;
    line-height: 1.12;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n1-tel {
    font-size: 7.0pt;
    font-weight: 600;
    line-height: 1.12;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n1-addr {
    font-size: 7.0pt;
    font-weight: 600;
    line-height: 1.18;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .n1-foot {
    border-top: 2px solid #000000;
    padding-top: 0.7mm;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.2mm;
    flex-shrink: 0;
  }
  .n1-status {
    padding: 0.4mm 1.05mm;
    font-size: 7.0pt;
  }
  .n1-foot-r {
    font-size: 7.0pt;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ==================== V1: FRANJA NEGRA SUPERIOR ==================== */
  .label-sheet.v1 {
    width: 58mm;
    height: 44mm;
    background: #FFFFFF;
    color: #000000;
    font-family: "Plus Jakarta Sans", "Segoe UI", Arial, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: none;
    text-rendering: geometricPrecision;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .v1-top {
    height: 5.5mm;
    background: #000000;
    color: #FFFFFF;
    padding: 0 2.1mm;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .v1-brand {
    display: flex;
    align-items: center;
    gap: 1.2mm;
    font-size: 7.2pt;
    font-weight: 800;
    letter-spacing: 0.03em;
    color: #FFFFFF;
    white-space: nowrap;
  }
  .v1-pila {
    width: 4.1mm;
    height: 4.1mm;
    display: block;
  }
  .v1-mode {
    font-size: 7.0pt;
    font-weight: 800;
    letter-spacing: 0.05em;
    color: #FFFFFF;
    white-space: nowrap;
  }
  .v1-order-row {
    padding: 1.0mm 2.1mm 0.9mm 2.1mm;
    border-bottom: 1.5px solid #000000;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5mm;
  }
  .v1-order {
    font-size: 13.5pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: -0.02em;
    white-space: nowrap;
  }
  .v1-order-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.45mm;
  }
  .v1-date {
    font-size: 6.2pt;
    font-weight: 700;
    line-height: 1;
    white-space: nowrap;
  }
  .v1-pkg {
    border: 1.2px solid #000000;
    padding: 0.45mm 1.1mm;
    font-size: 6.4pt;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
  }
  .v1-grid {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
  }
  .v1-left {
    width: 38.5mm;
    padding: 1.1mm 1.8mm 1.0mm 2.1mm;
    border-right: 1px solid #000000;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;
  }
  .v1-lbl {
    font-size: 6.0pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.04em;
  }
  .v1-name {
    margin-top: 0.45mm;
    font-size: 7.6pt;
    font-weight: 800;
    line-height: 1.12;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .v1-tel {
    margin-top: 0.35mm;
    font-size: 6.4pt;
    font-weight: 700;
    line-height: 1.12;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .v1-addr {
    margin-top: 0.5mm;
    font-size: 6.4pt;
    font-weight: 600;
    line-height: 1.2;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .v1-status {
    align-self: flex-start;
    border: 1.2px solid #000000;
    padding: 0.45mm 1.15mm;
    font-size: 6.4pt;
    font-weight: 800;
    line-height: 1;
    white-space: nowrap;
  }
  .v1-right {
    flex: 1;
    padding: 0.6mm 1.4mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.45mm;
  }
  .v1-qr-box {
    width: 14.5mm;
    height: 14.5mm;
  }
  .v1-qr-cap {
    font-size: 6.0pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.05em;
  }
  .v1-foot {
    height: 4.3mm;
    background: #000000;
    color: #FFFFFF;
    padding: 0 2.1mm;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 6.2pt;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.03em;
  }`;
}

function buildLabelHtml(payload = {}, options = {}) {
  const norm = normalizeDispatchPayload(payload);
  const variant = String(options.variant || 'n1').toLowerCase() === 'v1' ? 'v1' : 'n1';
  const qrSvg = generateQrSvg(norm.verify_url);

  const orderCode = escapeHtml(norm.order_code);
  const shippingMode = escapeHtml(norm.shipping_mode);
  const pkgDate = escapeHtml(`PAQUETE ${norm.package_index}/${norm.package_total} · ${norm.date}`);
  const pkgOnly = escapeHtml(`PAQUETE ${norm.package_index}/${norm.package_total}`);
  const dateOnly = escapeHtml(norm.date);
  const customerName = escapeHtml(norm.customer_name);
  const customerPhone = escapeHtml(norm.customer_phone);
  const addressLine = escapeHtml(norm.address_line);
  const paidLabel = escapeHtml(norm.paid_label);
  const unitsText = `${norm.items_count} ${norm.items_count === 1 ? 'ud.' : 'uds.'}`;
  const footRight = escapeHtml(`${norm.store_name} · ${unitsText}`);

  let bodyHtml;
  if (variant === 'v1') {
    const telHtml = customerPhone ? `<div class="v1-tel">Tel: ${customerPhone}</div>` : '';
    const addrHtml = addressLine ? `<div class="v1-addr">${addressLine}</div>` : '';
    const v1Store = escapeHtml(`TITANIO ${norm.store_name.toUpperCase()} · ${norm.items_count} UDS.`);
    bodyHtml = `
      <section class="label-sheet v1" data-variant="v1">
        <header class="v1-top">
          <div class="v1-brand">
            ${pilaInvertedSvg('v1-pila')}
            <span>TITANIO STORE</span>
          </div>
          <span class="v1-mode">${shippingMode}</span>
        </header>
        <div class="v1-order-row">
          <span class="v1-order">${orderCode}</span>
          <div class="v1-order-right">
            <span class="v1-date">${dateOnly}</span>
            <span class="v1-pkg">${pkgOnly}</span>
          </div>
        </div>
        <div class="v1-grid">
          <div class="v1-left">
            <div class="v1-to">
              <div class="v1-lbl">PARA:</div>
              <div class="v1-name">${customerName}</div>
              ${telHtml}
              ${addrHtml}
            </div>
            <div class="v1-status">${paidLabel}</div>
          </div>
          <div class="v1-right">
            <div class="qr-frame v1-qr-box">${qrSvg}</div>
            <div class="v1-qr-cap">VALIDAR</div>
          </div>
        </div>
        <footer class="v1-foot">
          <span>${v1Store}</span>
          <span>VALIDAR ENVÍO</span>
        </footer>
      </section>
    `;
  } else {
    const telHtml = customerPhone ? `<div class="n1-tel">${customerPhone}</div>` : '';
    const addrHtml = addressLine ? `<div class="n1-addr">${addressLine}</div>` : '';
    bodyHtml = `
      <section class="label-sheet n1" data-variant="n1">
        <div class="label-safe n1-safe">
          <div class="n1-main">
            <div class="n1-left">
              <div class="qr-frame">${qrSvg}</div>
              <div class="n1-qr-cap">Validar envío</div>
            </div>
            <div class="n1-right">
              <header class="n1-top">
                <div class="n1-brand">
                  ${pilaMonoSvg('n1-pila')}
                  <span>TITANIO STORE</span>
                </div>
                <span class="pill-dark n1-pill">${shippingMode}</span>
              </header>
              <div class="n1-order-block">
                <div class="n1-order">${orderCode}</div>
                <div class="n1-pkg-date">${pkgDate}</div>
              </div>
              <div class="n1-dest">
                <div class="n1-name">${customerName}</div>
                ${telHtml}
                ${addrHtml}
              </div>
            </div>
          </div>
          <footer class="n1-foot">
            <span class="box-2px n1-status">${paidLabel}</span>
            <span class="n1-foot-r">${footRight}</span>
          </footer>
        </div>
      </section>
    `;
  }

  return `<!doctype html><html lang="es"><head><meta charset="UTF-8" /><style>${buildSharedCss()}</style></head><body>${bodyHtml}</body></html>`;
}

/**
 * Convierte un buffer RGBA/BGRA (4 bytes/píxel) a un bitmap TSPL MSB 1-bit
 * (58 bytes/fila × 352 filas = 20,416 bytes; 0 = negro que quema, 1 = blanco).
 *
 * @param {Buffer|Uint8Array} pixelBuffer
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number, format?: 'rgba'|'bgra' }} [options]
 * @returns {Buffer}
 */
function rgbaToTsplBitmap(pixelBuffer, width = TARGET_W, height = TARGET_H, options = {}) {
  if (!pixelBuffer || typeof pixelBuffer.length !== 'number') {
    throw new Error('Buffer de píxeles inválido');
  }
  const w = Math.trunc(Number(width));
  const h = Math.trunc(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error('Dimensiones de imagen inválidas');
  }
  const expectedMin = w * h * 4;
  if (pixelBuffer.length < expectedMin) {
    throw new Error(`Buffer de píxeles incompleto: ${pixelBuffer.length} < ${expectedMin}`);
  }

  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : DEFAULT_THRESHOLD;
  const isBgra = String(options.format || 'rgba').toLowerCase() === 'bgra';

  const bitmap = Buffer.alloc(BITMAP_BYTES, 0xff);
  const maxY = Math.min(h, TARGET_H);
  const maxX = Math.min(w, TARGET_W);

  for (let y = 0; y < maxY; y++) {
    const rowOff = y * w * 4;
    const outRowOff = y * ROW_BYTES;
    for (let x = 0; x < maxX; x++) {
      const idx = rowOff + x * 4;
      const c0 = pixelBuffer[idx];
      const c1 = pixelBuffer[idx + 1];
      const c2 = pixelBuffer[idx + 2];
      const a = pixelBuffer[idx + 3];
      const r = isBgra ? c2 : c0;
      const g = c1;
      const b = isBgra ? c0 : c2;

      let lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (a < 255) {
        const alpha = a / 255;
        lum = lum * alpha + 255 * (1 - alpha);
      }

      if (lum < threshold) {
        bitmap[outRowOff + (x >> 3)] &= ~(0x80 >> (x & 7));
      }
    }
  }
  return bitmap;
}

/**
 * Envuelve un bitmap TSPL de 20,416 bytes con la cabecera y cierre exactos
 * validados en Q86-I-Printer.
 *
 * @param {Buffer} bitmapBuffer
 * @returns {Buffer}
 */
function wrapTsplCommand(bitmapBuffer) {
  if (!Buffer.isBuffer(bitmapBuffer) || bitmapBuffer.length !== BITMAP_BYTES) {
    throw new Error(`Bitmap TSPL debe medir exactamente ${BITMAP_BYTES} bytes`);
  }
  const headerLines = [
    'SIZE 58 mm,44 mm',
    'GAP 2 mm,0 mm',
    'SPEED 2',
    'DENSITY 9',
    'DIRECTION 0',
    'REFERENCE 0,0',
    'OFFSET 0 mm',
    'CLS',
    `BITMAP 0,0,${ROW_BYTES},${TARGET_H},0,`,
  ];
  return Buffer.concat([
    Buffer.from(headerLines.join('\r\n'), 'ascii'),
    bitmapBuffer,
    Buffer.from('\r\nPRINT 1,1\r\n', 'ascii'),
  ]);
}

/**
 * Renderiza un HTML en un BrowserWindow oculto 464 × 352 (deviceScaleFactor 1)
 * y devuelve la trama binaria TSPL completa lista para spooler RAW.
 */
async function renderHtmlToTsplBuffer(html, options = {}) {
  const { BrowserWindow } = options.electron || require('electron');
  const win = new BrowserWindow({
    show: false,
    width: TARGET_W,
    height: TARGET_H,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    backgroundColor: '#FFFFFF',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      zoomFactor: options.zoomFactor ?? ZOOM_FACTOR,
    },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (typeof win.webContents.setZoomFactor === 'function') {
      win.webContents.setZoomFactor(options.zoomFactor ?? ZOOM_FACTOR);
    }
    await win.webContents.executeJavaScript(
      'document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))'
    );
    let image = await win.webContents.capturePage({ x: 0, y: 0, width: TARGET_W, height: TARGET_H });
    const size = image.getSize();
    if (size.width !== TARGET_W || size.height !== TARGET_H) {
      image = image.resize({ width: TARGET_W, height: TARGET_H, quality: 'best' });
    }
    const bgra = image.toBitmap();
    const bitmap = rgbaToTsplBitmap(bgra, TARGET_W, TARGET_H, {
      format: 'bgra',
      threshold: options.threshold ?? DEFAULT_THRESHOLD,
    });
    return wrapTsplCommand(bitmap);
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch (_) { /* ignore */ }
  }
}

/**
 * Renderiza una o varias etiquetas TSPL (bucle 1..N si no viene package_index).
 */
async function renderDispatchTsplBuffers(payload, options = {}) {
  const items = expandPackagePayloads(payload);
  const buffers = [];
  for (const item of items) {
    const html = buildLabelHtml(item, { variant: options.variant || 'n1' });
    buffers.push(await renderHtmlToTsplBuffer(html, options));
  }
  return buffers;
}

module.exports = {
  TARGET_W,
  TARGET_H,
  ROW_BYTES,
  BITMAP_BYTES,
  DEFAULT_THRESHOLD,
  MAX_PACKAGES,
  ZOOM_FACTOR,
  escapeHtml,
  truncateAddressTwoLines,
  normalizeDispatchPayload,
  expandPackagePayloads,
  encodeQrMatrixPure,
  generateQrSvg,
  buildLabelHtml,
  rgbaToTsplBitmap,
  wrapTsplCommand,
  renderHtmlToTsplBuffer,
  renderDispatchTsplBuffers,
};
