/**
 * Handlers para comunicación con máquina fiscal HKA
 * Este módulo maneja la comunicación con el servidor fiscal y almacenamiento local
 */

const { ipcMain } = require('electron');
const http = require('http');
const { 
  startFiscalServer, 
  stopFiscalServer, 
  getServerStatus, 
  restartFiscalServer,
  getPythonInfo,
} = require('./fiscal-server-manager');
const {
  readSettings,
  writeSettings,
  normalizeFiscal,
  getSettingsPath,
  readFiscalResponsesFile,
  writeFiscalResponsesFile,
} = require('./titaniopos-settings-file');

// Configuración por defecto
const DEFAULT_FISCAL_CONFIG = {
  enabled: false,
  fiscalMode: false,
  comPort: 'COM1',
  serverUrl: 'http://localhost:3000',
  storeCode: '',
  cashRegisterNumber: '',
  lastConfigUpdate: '',
};

// Cargar configuración fiscal (sección fiscal del JSON unificado)
const loadFiscalConfig = (app) => {
  try {
    return normalizeFiscal(readSettings(app).fiscal);
  } catch (error) {
    console.error('[FISCAL] Error loading config:', error);
    return { ...DEFAULT_FISCAL_CONFIG };
  }
};

// Guardar configuración fiscal
const saveFiscalConfig = (app, config) => {
  try {
    const s = readSettings(app);
    s.fiscal = normalizeFiscal({ ...s.fiscal, ...config });
    writeSettings(app, s);
    console.log('[FISCAL] Config saved (unified):', getSettingsPath(app));
    return true;
  } catch (error) {
    console.error('[FISCAL] Error saving config:', error);
    return false;
  }
};

// Respuestas pendientes: fiscal-responses.json (aparte del JSON unificado de caja)
const loadFiscalResponses = (app) => {
  try {
    return readFiscalResponsesFile(app);
  } catch (error) {
    console.error('[FISCAL] Error loading responses:', error);
    return [];
  }
};

const saveFiscalResponses = (app, responses) => {
  try {
    writeFiscalResponsesFile(app, Array.isArray(responses) ? responses : []);
    return true;
  } catch (error) {
    console.error('[FISCAL] Error saving responses:', error);
    return false;
  }
};

// Hacer petición HTTP al servidor fiscal
const makeFiscalRequest = (url, method, data) => {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    
    // Forzar IPv4: reemplazar 'localhost' por '127.0.0.1' para evitar ::1 (IPv6)
    let hostname = urlObj.hostname;
    if (hostname === 'localhost') {
      hostname = '127.0.0.1';
    }
    
    const options = {
      hostname: hostname,
      port: urlObj.port || 3000,
      path: urlObj.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 segundos
    };
    
    console.log(`[FISCAL] ${method} ${hostname}:${options.port}${options.path}`);

    const req = http.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const jsonResponse = JSON.parse(responseData);
          resolve({ statusCode: res.statusCode, data: jsonResponse });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: responseData });
        }
      });
    });

    req.on('error', (error) => {
      console.error('[FISCAL] Request error:', error.message);
      reject(error);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    
    req.end();
  });
};

// Verificar conexión con servidor fiscal
const checkFiscalConnection = async (serverUrl) => {
  try {
    const result = await makeFiscalRequest(`${serverUrl}/fiscal/cola/estado`, 'GET');
    // Asegurar serialización limpia
    let data = null;
    try {
      data = result.data ? JSON.parse(JSON.stringify(result.data)) : null;
    } catch (e) {
      data = null;
    }
    return { connected: result.statusCode === 200, data };
  } catch (error) {
    return { connected: false, error: error.message };
  }
};

// Enviar factura o nota de crédito al servidor fiscal
// barcodeOpts: { enabled, type, format } — código de barras en la factura (autopago).
// formatOpts: { itemDescLen, nativeDiscount } — formato del ticket (ver el handler).
const sendFiscalInvoice = async (serverUrl, invoiceData, fiscalMode = true, barcodeOpts = null, formatOpts = null) => {
  try {
    const docType = invoiceData.type || 'factura';

    // Generar contenido según el tipo de documento
    let fiscalLines;
    if (docType === 'notacredito' || docType === 'creditnote') {
      fiscalLines = generateCreditNoteContent(invoiceData, formatOpts);
    } else {
      fiscalLines = generateFiscalContent(invoiceData, barcodeOpts, formatOpts);
    }
    
    // Si NO es modo fiscal, agregar indicador "NO FISCAL" al inicio
    if (!fiscalMode) {
      fiscalLines.unshift('i05*** NO FISCAL - PRUEBA ***');
    }
    
    const requestData = {
      parametros: fiscalLines,
      type: docType === 'creditnote' ? 'notacredito' : docType,
      file: 'Factura.txt',
    };

    console.log('[FISCAL] Sending document:', docType);
    console.log('[FISCAL] Lines:', fiscalLines);
    
    const result = await makeFiscalRequest(`${serverUrl}/fiscal`, 'POST', requestData);
    
    return {
      success: result.statusCode === 200 || result.statusCode === 201,
      ...result.data,
    };
  } catch (error) {
    console.error('[FISCAL] Error sending document:', error);
    return {
      success: false,
      error: error.message,
    };
  }
};

// Consultar estado de un trabajo fiscal
const checkFiscalJobStatus = async (serverUrl, jobId) => {
  try {
    const result = await makeFiscalRequest(`${serverUrl}/fiscal/estado/${jobId}`, 'GET');
    return {
      success: result.statusCode === 200,
      ...result.data,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  }
};

// Generar contenido del archivo fiscal HKA
// Formato según documentación HKA:
// - Códigos de tasa: ' '=Exento, '!'=General(16%), '"'=Reducida(8%), '#'=Adicional(31%)
// - Productos: [TasaIVA][Precio12dig][Cantidad8dig][Descripción]
// - Cierre: 101=Efectivo, 102=Débito, 103=Crédito, etc.
// Construye la línea de código de barras del HKA80.
// Comando validado contra hardware: 'j<tipo><posición><texto>{code}'
//   tipo 2=CODE128 · posición 0=cuerpo 1=pie · texto 0=sin número 1=con número
// La plantilla exacta vive en config (`barcodeRaw`, ej. 'j21{code}'); {code} se
// reemplaza por el código (alfanumérico). Devuelve null si está apagado o vacío.
const buildBarcodeLine = (code, opts) => {
  if (!opts || !opts.enabled || !opts.raw) return null;
  const clean = String(code || '').replace(/[^0-9A-Za-z]/g, '');
  if (String(opts.raw).includes('{code}')) {
    // Sin dato que codificar no se manda un 'j211' pelado (comando malformado).
    if (!clean) return null;
    return String(opts.raw).replace('{code}', clean);
  }
  return String(opts.raw);
};

const generateFiscalContent = (invoiceData, barcodeOpts = null, formatOpts = null) => {
  const lines = [];
  const descLen = normalizeItemDescLen(formatOpts && formatOpts.itemDescLen);
  // 'amount' (q-, default) | 'percent' (p-) | 'none'. Compat: nativeDiscount=false
  // (flag previa) equivale a 'none'.
  const discountMode = formatOpts && formatOpts.nativeDiscount === false
    ? 'none'
    : (formatOpts && formatOpts.discountMode) || 'amount';
  const descLeaders = !formatOpts || formatOpts.descLeaders !== false;
  
  // Datos del cliente (opcional)
  // Soporta tanto customerName/customerRif como client.name/client.rif
  const clientName = invoiceData.customerName || (invoiceData.client && invoiceData.client.name);
  const clientRif = invoiceData.customerRif || (invoiceData.client && invoiceData.client.rif);
  
  if (clientName) {
    // iS* = Nombre del cliente. Si la sanitización lo deja vacío (nombre 100%
    // no-ASCII) se omite la línea: un 'iS*' pelado es un comando malformado.
    const sanitizedName = sanitizeText(clientName, 40);
    if (sanitizedName) lines.push(`iS*${sanitizedName}`);
  }
  
  if (clientRif) {
    console.log('[FISCAL] Client RIF received:', clientRif);
    // iR* = RIF/Cédula del cliente (ej: V12345678, J123456789)
    const sanitizedRif = clientRif.replace(/[^0-9A-Za-z]/g, '');
    console.log('[FISCAL] Sanitized RIF:', sanitizedRif, 'length:', sanitizedRif.length);
    // Solo agregar si tiene más que solo la letra del tipo (V, J, E, etc.)
    if (sanitizedRif.length > 1) {
      lines.push(`iR*${sanitizedRif}`);
      console.log('[FISCAL] RIF line added: iR*' + sanitizedRif);
    } else {
      console.log('[FISCAL] Skipping empty RIF - only has:', sanitizedRif);
    }
  } else {
    console.log('[FISCAL] No client RIF provided');
  }
  
  // Línea de comentario con caja y número de orden (i05 = línea adicional)
  const comment = `Caja: ${invoiceData.cashRegisterNumber || 'N/A'} - ${invoiceData.orderNumber || 'N/A'}`;
  lines.push(`i05${comment}`);

  // Productos
  let docTotalCents = 0; // neto + IVA (modelo de la máquina) para el clamp del cierre
  if (invoiceData.products && Array.isArray(invoiceData.products)) {
    for (const product of invoiceData.products) {
      const taxCode = taxCodeFor(product.taxRate, TAX_CHARS_FACTURA);

      // Precio en centavos (sin decimales), 10 dígitos
      // IMPORTANTE: Es el precio UNITARIO, no el total
      // OJO HKA80: el precio es de 10 dígitos. Con 12 la impresora lee mal
      // los campos y sale 0.01 x 0.01. Verificado con hardware real.
      const priceNum = parseFloat(product.price) || 0;
      const priceInCents = Math.round(priceNum * 100);

      // Cantidad en milésimas, 8 dígitos (ej: 1.000 = 00001000)
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');

      // Descripción SOLO en la línea del ítem, cortada por palabra. SIN líneas '@' de
      // continuación: la HKA las enmarca con '|' y el ticket quedaba ilegible (no se
      // distinguía qué línea era de qué producto). El largo es configurable
      // (fiscal.itemDescLen) para probar en hardware cuánto admite la HKA80.
      const fullDescription = sanitizeText(product.description || 'PRODUCTO', 200);
      const itemDesc = firstLine(fullDescription, descLen);

      // DESCUENTO NATIVO: ítem al precio de LISTA + comando 'q-'/'p-' sobre el
      // último renglón (manual oficial). La HKA imprime la línea de descuento en
      // formato fiscal (sin '|') pegada a su producto y calcula el IVA sobre el
      // neto. Con fiscal.discountMode='none' el ítem va al precio neto, como antes.
      //
      // PRECISIÓN QUIRÚRGICA: si el frontend envía `lineTotalBs` (el total NETO
      // exacto de la línea que cobró el POS), se garantiza ese total aunque no
      // sea representable como unitario×cantidad (ej. total impar con qty par):
      // se sube el unitario 1 céntimo y un 'q-' del residuo cuadra el renglón.
      const fit = discountMode !== 'none'
        ? fitExactLine(product, priceInCents, discountMode)
        : null;
      const priceStr = fit ? fit.priceStr : priceInCents.toString().padStart(10, '0');

      // Formato final: [TasaIVA][Precio10][Cantidad8][Descripción]
      // Con puntos de guía ('NOMBRE .......') hasta el ancho del campo, para que
      // la vista llegue fácil del nombre a los números (fiscal.descLeaders=false
      // los apaga).
      const descField = descLeaders ? withDotLeaders(itemDesc, descLen) : itemDesc;
      const productLine = `${taxCode}${priceStr}${qtyStr}${descField}`;
      console.log(`[FISCAL] Product line: price=${product.price} -> "${priceStr}" | qty=${product.quantity} -> "${qtyStr}" | LINE="${productLine}"`);
      lines.push(productLine);
      if (fit) {
        if (fit.deltaCents !== 0) {
          console.warn(`[FISCAL] Descuento nativo sin cuadre exacto: residuo ${fit.deltaCents} centavo(s) en "${itemDesc}"`);
        }
        if (fit.discountLine) lines.push(fit.discountLine);
      }

      // Neto de la línea según el mismo target que garantiza fitExactLine.
      const netCents = product.lineTotalBs != null
        ? Math.round((parseFloat(product.lineTotalBs) || 0) * 100)
        : Math.round(priceInCents * (parseFloat(product.quantity) || 1));
      docTotalCents += netCents + Math.round((netCents * (TAX_RATE_BY_CHAR[taxCode] || 0)) / 100);
    }
  }

  // Código de barras: codifica el ÚLTIMO SEGMENTO del UUID de la orden (lo que va
  // después del último guion, ej. '...-fb1ee5833e35' → 'fb1ee5833e35'). Es más
  // específico que el short_id de 4 chars. Va DESPUÉS de los productos y ANTES del
  // cierre (al pie); el comando 'j' debe enviarse con el documento abierto.
  const barcodeCode = invoiceData.orderUuid
    ? String(invoiceData.orderUuid).split('-').pop()
    : invoiceData.orderNumber;
  const barcodeLine = buildBarcodeLine(barcodeCode, barcodeOpts);
  if (barcodeLine) {
    console.log('[FISCAL] Barcode line:', barcodeLine);
    lines.push(barcodeLine);
  }

  // Cierre de factura - forma(s) de pago.
  // Códigos HKA: 01=Efectivo, 02=Débito, 03=Crédito, 04=Otros.
  // 20-24 = DIVISA (moneda extranjera): la impresora calcula e imprime el
  //         IGTF (3%) automáticamente al cerrar con uno de estos medios.
  // El comando de cierre es '1' + código de 2 dígitos (ej. '101', '120').
  for (const line of buildCloseLines(invoiceData, docTotalCents)) {
    lines.push(line);
  }

  return lines;
};

// Construye la(s) línea(s) de cierre de una factura a partir de los pagos.
//
// Contrato con el frontend: invoiceData.payments = [{ code, amountBs }]
//   - code: código HKA de 2 dígitos del medio de pago ('01' efectivo, '20' divisa, ...)
//   - amountBs: monto de ESE pago en bolívares (para pagos mixtos). Opcional.
//
// Reglas:
//   - Sin payments (o vacío): back-compat → una sola línea '1' + (paymentType || '01').
//   - Un solo pago: cierre por total completo '1'+code (sin monto). Robusto: no
//     depende de que el monto cuadre al céntimo con lo que calculó la impresora.
//   - Varios pagos (mixto): PARCIALES '2'+code+monto(12 díg) para todos menos el
//     último, y cierre '1'+code SIN monto para el último (absorbe el restante).
//     El comando '1' con monto NO es un pago parcial: cierra el documento, y la
//     línea siguiente da NAK (visto en HW el 15-07: '120...' ACK, '101...' NAK).
//     El patrón 2XX/2XX/.../1XX es el validado por la prueba op:factura-pago-parcial.
//     El pago en divisa (20-24) va como parcial: la impresora registra el monto y
//     calcula el IGTF; el cierre final en el medio no-divisa cubre ese IGTF.
const buildCloseLines = (invoiceData, docTotalCents = null) => {
  const paymentsRaw = Array.isArray(invoiceData.payments) ? invoiceData.payments : [];
  // Reembolsos/vueltos (monto <= 0) NO son parciales fiscales: el cierre '1XX' sin
  // monto absorbe el neto. Mandarlos corrompía el cierre (el clamp de abajo no los
  // puede representar y un negativo se colaba como parcial inflado del resto).
  const payments = paymentsRaw.filter((p) => {
    const n = parseFloat(p.amountBs);
    return !(Number.isFinite(n) && n <= 0);
  });

  const normCode = (c, fallback) => {
    const digits = String(c ?? '').replace(/\D/g, '');
    return digits.length ? digits.padStart(2, '0').slice(-2) : fallback;
  };
  const isDivisaCode = (code) => {
    const n = parseInt(code, 10);
    return n >= 20 && n <= 24;
  };

  let closeLines;
  if (payments.length === 0) {
    // Compatibilidad con el flujo previo: paymentType podía venir ya como '101'.
    closeLines = [String(invoiceData.paymentType || '101')];
  } else if (payments.length === 1) {
    closeLines = [`1${normCode(payments[0].code, '01')}`];
  } else {
    // Pago mixto: parciales '2'+code+monto y UN solo cierre '1'+code sin monto.
    // El cierre final debe ser preferiblemente un medio NO-divisa (efectivo/punto):
    // la divisa como parcial explícito registra su monto exacto (base del IGTF),
    // y el medio local absorbe el restante (IGTF + desfases de céntimos).
    const isDivisa = (p) => isDivisaCode(normCode(p.code, '04'));
    const ordered = [...payments].sort((a, b) => Number(isDivisa(b)) - Number(isDivisa(a)));
    const closer = ordered[ordered.length - 1];
    closeLines = [];
    // CLAMP contra el total del documento (neto + IVA de las líneas, mismo modelo
    // validado contra papel): un parcial que cubra el saldo CIERRA el documento y
    // las líneas siguientes NAKean (visto en HW 15-07). El saldo incluye el IGTF
    // (3% half-up) que el propio parcial divisa agrega. Se deja >= 1 céntimo para
    // el cierre final. Sin docTotalCents (llamadas viejas) no se recorta.
    let dueCents = docTotalCents;
    let paidCents = 0;
    for (const p of ordered.slice(0, -1)) {
      const code = normCode(p.code, '04'); // sin código claro → "otros"
      let cents = Math.max(0, Math.round((parseFloat(p.amountBs) || 0) * 100));
      if (cents <= 0) continue; // sin monto real no hay parcial: lo absorbe el cierre
      const dv = isDivisaCode(code);
      if (dueCents != null) {
        let igtf = dv ? Math.round(cents * 0.03) : 0;
        if (paidCents + cents >= dueCents + igtf) {
          cents = Math.max(0, dueCents + igtf - paidCents - 1);
          igtf = dv ? Math.round(cents * 0.03) : 0;
          if (paidCents + cents >= dueCents + igtf) {
            cents = Math.max(0, dueCents + igtf - paidCents - 1);
          }
          console.warn(`[FISCAL] Parcial ${code} recortado al saldo del documento (evita cierre prematuro)`);
        }
        if (cents <= 0) continue;
        dueCents += dv ? Math.round(cents * 0.03) : 0;
        paidCents += cents;
      }
      closeLines.push(`2${code}${cents.toString().padStart(12, '0')}`);
    }
    closeLines.push(`1${normCode(closer.code, '01')}`);
  }

  // '199' = cerrar/finalizar el documento (corta el papel). SIN esto la HKA80
  // paga pero deja la factura a la mitad y no corta (validado en hardware).
  closeLines.push('199');
  return closeLines;
};

// Largo de la descripción en la línea del ítem. La descripción es el campo FINAL de
// la trama, así que un largo mayor no puede romper el parseo de precio/cantidad — a
// lo sumo la impresora la recorta. Default 40 (aprovechar el ancho del papel);
// `fiscal.itemDescLen` en la config lo ajusta (10-100) según lo que la HKA80
// realmente imprima en la caja.
const ITEM_DESC_LEN = 40;   // default (pendiente confirmar el máximo real en HW)
const ITEM_DESC_MIN = 10;
const ITEM_DESC_MAX = 100;  // techo del override por config (evita tramas gigantes)
const EXTRA_LINE_LEN = 40;  // ancho del papel para las líneas '@' (motivo de NC)

const normalizeItemDescLen = (raw) => {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ITEM_DESC_LEN;
  return Math.min(ITEM_DESC_MAX, Math.max(ITEM_DESC_MIN, n));
};

// Códigos de tasa IVA por documento. El umbral de la ADICIONAL (>20, en la práctica
// 31% = 16+15 suntuario) se evalúa PRIMERO: con el orden viejo (general primero) esa
// rama era inalcanzable y un producto al 31% se facturaba como general (16%).
const TAX_CHARS_FACTURA = { exento: ' ', general: '!', reducida: '"', adicional: '#' };
const TAX_CHARS_NC = { exento: '0', general: '1', reducida: '2', adicional: '3' };
// Alícuota que la máquina aplica por código de tasa (para predecir el total del
// documento y recortar parciales que lo excederían).
const TAX_RATE_BY_CHAR = { ' ': 0, '!': 16, '"': 8, '#': 31, '0': 0, '1': 16, '2': 8, '3': 31 };

const taxCodeFor = (taxRate, chars) => {
  const rate = Number(taxRate) || 0;
  if (rate > 20) return chars.adicional;
  if (rate >= 15) return chars.general;
  if (rate >= 7) return chars.reducida;
  return chars.exento;
};

/**
 * Envuelve un texto en líneas de EXTRA_LINE_LEN caracteres cortando por palabras;
 * una palabra sola más larga que la línea se trocea. Devuelve el texto SIN prefijo.
 */
/**
 * Envuelve un texto en líneas cortando POR PALABRA. La primera línea admite hasta
 * `firstW` caracteres (la de la línea del ítem, 20) y las siguientes hasta `restW`
 * (las '@', 40). Antes se cortaban 20 chars a lo bruto y una palabra quedaba partida
 * a la mitad ("...GALV" / "ANIZADA..."); ahora la primera línea rompe en el último
 * espacio que cabe ("PAR BISAGRA 3X3" / "GALVANIZADA PARA..."). Una palabra sola más
 * larga que la línea sí se trocea (no hay alternativa).
 */
const wrapWords = (text, firstW, restW) => {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let word of words) {
    let limit = lines.length === 0 ? firstW : restW;
    // Palabra que no cabe ni en una línea vacía: trocearla.
    while (word.length > limit) {
      if (cur) { lines.push(cur); cur = ''; }
      limit = lines.length === 0 ? firstW : restW;
      lines.push(word.substring(0, limit));
      word = word.substring(limit);
      limit = lines.length === 0 ? firstW : restW;
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= limit) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
};

/** Compat: envoltura a 40 para texto libre (motivo, etc.). */
const wrapText40 = (text) => wrapWords(text, EXTRA_LINE_LEN, EXTRA_LINE_LEN);

/** Primera línea de un texto cortada POR PALABRA a `width` caracteres. */
const firstLine = (text, width) => wrapWords(text, width, width)[0] || 'PRODUCTO';

/**
 * Renglón EXACTO al céntimo. Devuelve {priceStr, discountLine|null, deltaCents}
 * o null (mandar el precio neto tal cual, sin ajuste).
 *
 * - Con descuento (listPrice > price): renglón a LISTA + 'q-' con el monto
 *   exacto ('p-' en modo percent).
 * - Sin descuento pero con `lineTotalBs` del POS que NO es unitario×cantidad
 *   (round-late del cobro vs round-early de la impresora — ej. total impar con
 *   cantidad par): unitario mínimo que alcance el total y 'q-' de los céntimos
 *   sobrantes. Sin esto, UI y papel divergen por céntimos.
 */
const fitExactLine = (product, priceInCents, mode) => {
  const q = parseFloat(product.quantity) || 1;
  const targetNet = product.lineTotalBs != null
    ? Math.round((parseFloat(product.lineTotalBs) || 0) * 100)
    : Math.round(priceInCents * q);
  if (targetNet <= 0) return null;

  const listCents = Math.round((parseFloat(product.listPrice) || 0) * 100);
  if (listCents > priceInCents) {
    const fit = fitNativeDiscount(product.listPrice, product.price, q, mode, targetNet);
    if (fit) return fit;
  }

  // Sin descuento (o no aplicó): ¿el unitario ya reproduce el total exacto?
  if (Math.round(priceInCents * q) === targetNet) return null;
  if (mode === 'percent') return null; // el ajuste fino requiere 'q-' por monto

  // Unitario mínimo cuyo total alcanza el target; el excedente sale como 'q-'.
  let unit = Math.max(1, Math.floor(targetNet / q));
  while (Math.round(unit * q) < targetNet) unit++;
  const disc = Math.round(unit * q) - targetNet;
  if (disc > 999999999) return null;
  return {
    priceStr: String(unit).padStart(10, '0'),
    discountLine: disc > 0 ? `q-${String(disc).padStart(9, '0')}` : null,
    deltaCents: 0,
  };
};

/**
 * 'NOMBRE .........' — puntos de guía hasta `width` que conducen la vista del
 * nombre a los números que la HKA imprime a continuación en el renglón. Si el
 * nombre casi llena el campo no se agregan (menos de 3 puntos no guían nada).
 */
const withDotLeaders = (name, width) => {
  if (name.length >= width - 3) return name;
  return `${name} ${'.'.repeat(width - name.length - 1)}`;
};

/**
 * Descuento NATIVO de la HKA: el renglón se envía al precio de LISTA y detrás va
 * 'p-PPPP' (% con 2 enteros + 2 decimales sobre el último renglón — la sintaxis de
 * las secuencias "Fijas" del Fiscalizador oficial, ej. 'p-5000' = 50,00%). La
 * impresora imprime la línea de descuento en formato fiscal y calcula el IVA sobre
 * el neto.
 *
 * Dos variantes (manual oficial v8.3/v8.5, sección DESCUENTOS Y RECARGOS; el SDK
 * oficial de The Factory usa ambas):
 *   'q-' + monto 9 díg (7+2) — POR MONTO (default): se envía el monto EXACTO del
 *        descuento del renglón → el neto cuadra al céntimo POR CONSTRUCCIÓN, sin
 *        depender del modelo de redondeo de la impresora.
 *   'p-' + pppp (2+2)        — PORCENTUAL (fiscal.discountMode='percent', validado
 *        en HW 20-07): imprime 'DESC (pp,pp%)'; el % de 2 decimales redondea, así
 *        que se busca el par (lista ±5c, % ±0,05) que mejor cuadre el neto y el
 *        caller loguea el residuo (`deltaCents`).
 *
 * Devuelve null si no hay descuento real (sin listPrice, o lista <= neto) — el
 * caller manda entonces el renglón al precio neto, como siempre.
 */
const fitNativeDiscount = (listUnit, paidUnit, qty, mode = 'amount', targetNetOverride = null) => {
  const listCents = Math.round((parseFloat(listUnit) || 0) * 100);
  const paidCents = Math.round((parseFloat(paidUnit) || 0) * 100);
  if (listCents <= 0 || paidCents <= 0 || listCents <= paidCents) return null;
  const q = parseFloat(qty) || 1;
  // Neto exacto del renglón en centavos: el que cobró el POS si lo envía
  // (lineTotalBs, round-late), si no el modelo unitario.
  const targetNet = targetNetOverride != null ? targetNetOverride : Math.round(paidCents * q);

  if (mode !== 'percent') {
    const lineTotal = Math.round(listCents * q);
    const disc = lineTotal - targetNet;
    // Fuera de rango del comando (7+2 dígitos) o sin descuento tras redondear:
    // sin línea nativa; el renglón va al neto (exacto, solo que sin mostrarlo).
    if (disc <= 0 || disc > 999999999) return null;
    return {
      priceStr: String(listCents).padStart(10, '0'),
      discountLine: `q-${String(disc).padStart(9, '0')}`,
      deltaCents: 0,
    };
  }

  const basePct = Math.round((1 - paidCents / listCents) * 10000); // centésimas de %

  const candidates = [];
  for (let dl = -5; dl <= 5; dl++) {
    const lc = listCents + dl;
    if (lc <= paidCents) continue;
    const lineTotal = Math.round(lc * q);
    for (let dp = -5; dp <= 5; dp++) {
      const pct = basePct + dp;
      if (pct <= 0 || pct > 9999) continue;
      const predictedNet = lineTotal - Math.round((lineTotal * pct) / 10000);
      candidates.push({
        lc, pct,
        delta: Math.abs(predictedNet - targetNet),
        dev: Math.abs(dl),
        pctDev: Math.abs(dp),
      });
    }
  }
  if (!candidates.length) return null;
  // Exactitud primero; a igual delta, la lista más fiel a la real y el % más fiel.
  candidates.sort((a, b) => a.delta - b.delta || a.dev - b.dev || a.pctDev - b.pctDev);
  const best = candidates[0];
  return {
    priceStr: String(best.lc).padStart(10, '0'),
    discountLine: `p-${String(best.pct).padStart(4, '0')}`,
    deltaCents: best.delta,
  };
};

// Función auxiliar para limpiar texto (eliminar acentos y caracteres especiales)
const sanitizeText = (text, maxLength = 20) => {
  return (text || '')
    .substring(0, maxLength)
    // Transliteraciones ANTES del filtro ASCII: en ferreter\u00eda '\u00bd'/'\u00be'/'\u00d8' son
    // parte del nombre ('TUBO \u00bd', 'BROCA \u00d88') y borrarlos dejaba productos
    // distintos con descripci\u00f3n id\u00e9ntica en la factura fiscal.
    .replace(/\u00bd/g, '1/2')
    .replace(/\u00bc/g, '1/4')
    .replace(/\u00be/g, '3/4')
    .replace(/[\u00d8\u00f8\u2300]/g, 'O')
    .replace(/\u00b0/g, 'o')
    .replace(/[\u00d7\u2715]/g, 'X')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
    .replace(/[^\x20-\x7E]/g, '')    // Solo caracteres ASCII imprimibles
    .trim();
};

// Generar contenido para Nota de Crédito (devolución)
// Formato según documentación HKA:
// iR* = RIF/Cédula del cliente
// iS* = Nombre del cliente
// iF* = Número de factura original (11 dígitos)
// iD* = Fecha de factura original (DD-MM-YYYY)
// iI* = Serial de la impresora que emitió la factura original
// A = Comentario de nota de crédito
// d0 = Producto exento, d1 = Tasa general, d2 = Tasa reducida, d3 = Tasa adicional
const generateCreditNoteContent = (creditNoteData, formatOpts = null) => {
  const lines = [];
  const descLen = normalizeItemDescLen(formatOpts && formatOpts.itemDescLen);
  const descLeaders = !formatOpts || formatOpts.descLeaders !== false;
  
  // Datos del cliente (requeridos para nota de crédito)
  if (creditNoteData.customerRif) {
    const customerRif = creditNoteData.customerRif.replace(/[^0-9A-Za-z]/g, '');
    lines.push(`iR*${customerRif}`);
  }
  
  if (creditNoteData.customerName) {
    const customerName = sanitizeText(creditNoteData.customerName, 40);
    if (customerName) lines.push(`iS*${customerName}`);
  }
  
  // Datos de la factura original (requeridos)
  if (creditNoteData.originalInvoiceNumber) {
    // Formato: EXACTAMENTE 11 dígitos. Solo dígitos ('F-00001234' → '00001234')
    // y truncado por la izquierda si viene más largo — la HKA rechaza el campo
    // con letras/guiones o con más de 11 dígitos.
    const digits = String(creditNoteData.originalInvoiceNumber).replace(/\D/g, '');
    if (digits) {
      lines.push(`iF*${digits.padStart(11, '0').slice(-11)}`);
    }
  }
  
  if (creditNoteData.originalInvoiceDate) {
    // Formato: DD-MM-YYYY
    let dateStr = creditNoteData.originalInvoiceDate;
    // Si viene en formato ISO, convertir
    if (dateStr.includes('-') && dateStr.length > 10) {
      const date = new Date(dateStr);
      const day = date.getDate().toString().padStart(2, '0');
      const month = (date.getMonth() + 1).toString().padStart(2, '0');
      const year = date.getFullYear();
      dateStr = `${day}-${month}-${year}`;
    } else if (dateStr.includes('-') && dateStr.length === 10 && dateStr.indexOf('-') === 4) {
      // Formato YYYY-MM-DD -> DD-MM-YYYY
      const [year, month, day] = dateStr.split('-');
      dateStr = `${day}-${month}-${year}`;
    }
    lines.push(`iD*${dateStr}`);
  }
  
  if (creditNoteData.originalPrinterSerial) {
    // Serial de la impresora fiscal original
    lines.push(`iI*${creditNoteData.originalPrinterSerial}`);
  }
  
  // Línea de referencia con caja y número de orden
  const orderComment = `Caja: ${creditNoteData.cashRegisterNumber || 'N/A'} - ${creditNoteData.orderNumber || 'N/A'}`;
  lines.push(`i05${orderComment}`);

  // MOTIVO de la NC: va ANTES de los productos (texto libre '@'), como lo pidió caja.
  // Se envuelve a 40 caracteres cortando por palabras.
  if (creditNoteData.comment) {
    const motivo = sanitizeText(creditNoteData.comment, 200);
    for (const chunk of wrapText40(`Motivo: ${motivo}`)) {
      lines.push(`@${chunk}`);
    }
  }

  // Productos para devolución
  // Formato: d[TasaIVA][Precio12dig][Cantidad8dig][Descripción]
  // d0 = Exento, d1 = Tasa General, d2 = Tasa Reducida, d3 = Tasa Adicional
  let docTotalCents = 0; // neto + IVA para el clamp del cierre (igual que la factura)
  if (creditNoteData.products && Array.isArray(creditNoteData.products)) {
    for (const product of creditNoteData.products) {
      const taxCode = taxCodeFor(product.taxRate, TAX_CHARS_NC);

      // Precio en centavos, 10 dígitos (formato HKA80, ver generateFiscalContent).
      // La NC va al precio NETO cobrado (devuelve exacto lo facturado). No se usa
      // 'p-' aquí: el Fiscalizador oficial nunca lo combina con renglones 'd' y un
      // NAK dejaría la devolución a medias.
      const priceInCents = Math.round((product.price || 0) * 100);
      const priceStr = priceInCents.toString().padStart(10, '0');

      // Cantidad en milésimas, 8 dígitos
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');

      // Descripción solo en la línea del ítem, cortada por palabra (sin líneas '@'
      // → sin '|') y con puntos de guía, igual que la factura.
      const fullDescription = sanitizeText(product.description || 'PRODUCTO', 200);
      const itemDesc = firstLine(fullDescription, descLen);
      const descField = descLeaders ? withDotLeaders(itemDesc, descLen) : itemDesc;

      // Formato: d[TasaIVA][Precio][Cantidad][Descripción]
      lines.push(`d${taxCode}${priceStr}${qtyStr}${descField}`);

      const netCents = Math.round(priceInCents * (parseFloat(product.quantity) || 1));
      docTotalCents += netCents + Math.round((netCents * (TAX_RATE_BY_CHAR[taxCode] || 0)) / 100);
    }
  }

  // Cierre (mismo contrato que la factura: reversa el IGTF si el pago era divisa)
  for (const line of buildCloseLines(creditNoteData, docTotalCents)) {
    lines.push(line);
  }

  return lines;
};

// Registrar handlers IPC
const registerFiscalHandlers = (app) => {
  console.log('[FISCAL] Registering handlers...');

  // Obtener configuración fiscal
  ipcMain.handle('fiscal-config-get', async () => {
    try {
      const config = loadFiscalConfig(app);
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Guardar configuración fiscal
  ipcMain.handle('fiscal-config-save', async (event, config) => {
    try {
      const currentConfig = loadFiscalConfig(app);
      const newConfig = { 
        ...currentConfig, 
        ...config, 
        lastConfigUpdate: new Date().toISOString() 
      };
      const saved = saveFiscalConfig(app, newConfig);
      return { success: saved, config: newConfig };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Verificar conexión con servidor fiscal
  ipcMain.handle('fiscal-check-connection', async (event, serverUrl) => {
    try {
      const config = loadFiscalConfig(app);
      const url = serverUrl || config.serverUrl || 'http://127.0.0.1:3000';
      console.log('[FISCAL] Checking connection to:', url);
      const result = await checkFiscalConnection(url);
      console.log('[FISCAL] Connection result:', result.connected);
      return { success: true, connected: result.connected || false };
    } catch (error) {
      console.error('[FISCAL] Connection check error:', error.message);
      return { success: false, connected: false, error: error.message };
    }
  });

  // Enviar factura fiscal
  ipcMain.handle('fiscal-send-invoice', async (event, invoiceData) => {
    try {
      const config = loadFiscalConfig(app);
      
      // Verificar si está habilitado
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }

      // En modo no fiscal, igual imprimimos pero marcamos como no fiscal
      // Esto permite probar la impresora sin afectar datos fiscales reales
      const isFiscalMode = config.fiscalMode === true;
      if (!isFiscalMode) {
        console.log('[FISCAL] Non-fiscal mode - printing with NO FISCAL indicator');
      }

      // Código de barras SIEMPRE, con el nº de orden (últimos dígitos del UUID). Se
      // puede apagar poniendo printBarcode:false explícito en la config. La plantilla
      // 'j211{code}' está validada en HW (CODE128, al pie, con número).
      const barcodeOpts = {
        enabled: config.printBarcode !== false,
        raw: config.barcodeRaw || 'j211{code}',
      };

      // Formato del ticket, ajustable desde el JSON de settings sin rebuild:
      //   fiscal.itemDescLen  — largo del nombre en la línea del ítem (10-100, def 40).
      //   fiscal.discountMode — 'amount' (q-, exacto, default) | 'percent' (p-) |
      //                         'none' (sin descuento nativo, renglón al neto).
      //   fiscal.descLeaders  — false apaga los puntos de guía 'NOMBRE ....'.
      const formatOpts = {
        itemDescLen: config.itemDescLen,
        discountMode: config.discountMode,
        descLeaders: config.descLeaders !== false,
      };

      // Enviar factura (pasando fiscalMode para agregar indicador si es prueba).
      // Para NOTA DE CRÉDITO, el serial de la máquina (iI*) sale de la config si
      // el frontend no lo envió — es un dato fijo de la caja.
      const result = await sendFiscalInvoice(config.serverUrl, {
        ...invoiceData,
        cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
        originalPrinterSerial: invoiceData.originalPrinterSerial || config.machineSerial || undefined,
      }, isFiscalMode, barcodeOpts, formatOpts);

      if (result.success) {
        // Guardar respuesta con los datos del resultado del servidor fiscal
        const responses = loadFiscalResponses(app);
        const jobId = result.job_id || `local-${Date.now()}`;
        
        // El resultado puede incluir la respuesta directa del servidor fiscal
        const fiscalResponse = result.result || result;

        responses.push({
          id: jobId,
          orderUuid: invoiceData.orderUuid,
          orderNumber: invoiceData.orderNumber,
          storeCode: invoiceData.storeCode,
          cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
          documentType: invoiceData.type || 'factura',
          // 'ok' en el POST significa ENCOLADO, no impreso: marcarlo 'completado'
          // aquí hacía que el sync subiera la respuesta al backend SIN
          // numero_fiscal (el resultado real lo trae el job al terminar). Queda
          // 'pending' y fiscal-check-job-status lo completa con el resultado.
          status: 'pending',
          response: fiscalResponse,
          createdAt: new Date().toISOString(),
          syncedToBackend: false,
          syncAttempts: 0,
        });
        saveFiscalResponses(app, responses);
        console.log('[FISCAL] Saved response with fiscal data:', JSON.stringify(fiscalResponse).substring(0, 200));
      }

      return result;
    } catch (error) {
      console.error('[FISCAL] Error in send-invoice:', error);
      return { success: false, error: error.message };
    }
  });

  // Consultar estado de trabajo fiscal
  ipcMain.handle('fiscal-check-job-status', async (event, jobId) => {
    try {
      const config = loadFiscalConfig(app);
      
      if (!config.fiscalMode) {
        // En modo no fiscal, devolver estado completado
        return {
          success: true,
          job_id: jobId,
          estado: 'completado',
          simulated: true,
        };
      }

      const result = await checkFiscalJobStatus(config.serverUrl, jobId);
      
      // Actualizar respuesta local si cambió el estado
      if (result.success) {
        const responses = loadFiscalResponses(app);
        const idx = responses.findIndex(r => r.id === jobId);
        if (idx !== -1) {
          responses[idx].status = result.estado;
          if (result.estado === 'completado' || result.estado === 'error') {
            responses[idx].processedAt = new Date().toISOString();
            // Guardar la respuesta íntegra del servidor fiscal (incluye resultado de hka_serial)
            responses[idx].response = result.resultado || result;
          }
          saveFiscalResponses(app, responses);
        }
      }

      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Obtener respuestas fiscales pendientes de sincronización
  ipcMain.handle('fiscal-get-pending-responses', async () => {
    try {
      const responses = loadFiscalResponses(app);
      const pending = responses.filter(r =>
        !r.syncedToBackend &&
        !r.simulated &&                 // las simuladas nunca sincronizan (orden falsa)
        !r.syncPermanentlyFailed &&     // errores permanentes (422) ya no cuentan
        (r.status === 'completed' || r.status === 'completado' || r.status === 'error')
      );
      return { success: true, responses: pending };
    } catch (error) {
      return { success: false, error: error.message, responses: [] };
    }
  });

  // Marcar respuesta como sincronizada
  ipcMain.handle('fiscal-mark-synced', async (event, responseId) => {
    try {
      const responses = loadFiscalResponses(app);
      const idx = responses.findIndex(r => r.id === responseId);
      if (idx !== -1) {
        responses[idx].syncedToBackend = true;
        responses[idx].lastSyncAttempt = new Date().toISOString();
        saveFiscalResponses(app, responses);
        return { success: true };
      }
      return { success: false, error: 'Response not found' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Marcar error de sincronización. `permanent` (o demasiados intentos) marca la
  // respuesta como fallo permanente para dejar de reintentarla eternamente (422 =
  // la orden no existe/payload inválido; reintentar no lo va a arreglar).
  ipcMain.handle('fiscal-mark-sync-error', async (event, responseId, errorMessage, permanent = false) => {
    try {
      const responses = loadFiscalResponses(app);
      const idx = responses.findIndex(r => r.id === responseId);
      if (idx !== -1) {
        responses[idx].syncAttempts = (responses[idx].syncAttempts || 0) + 1;
        responses[idx].lastSyncAttempt = new Date().toISOString();
        responses[idx].syncError = errorMessage;
        if (permanent || responses[idx].syncAttempts >= 20) {
          responses[idx].syncPermanentlyFailed = true;
        }
        saveFiscalResponses(app, responses);
        return { success: true, permanent: responses[idx].syncPermanentlyFailed === true };
      }
      return { success: false, error: 'Response not found' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Purga respuestas atascadas. mode 'stuck' (default): sincronizadas + simuladas +
  // fallos permanentes. mode 'all': todas. Devuelve cuántas se eliminaron.
  ipcMain.handle('fiscal-purge-responses', async (event, mode = 'stuck') => {
    try {
      const responses = loadFiscalResponses(app);
      const keep = mode === 'all' ? [] : responses.filter(r =>
        !r.syncedToBackend && !r.simulated && !r.syncPermanentlyFailed);
      const removed = responses.length - keep.length;
      saveFiscalResponses(app, keep);
      return { success: true, removed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Obtener todas las respuestas fiscales
  ipcMain.handle('fiscal-get-all-responses', async () => {
    try {
      const responses = loadFiscalResponses(app);
      return { success: true, responses };
    } catch (error) {
      return { success: false, error: error.message, responses: [] };
    }
  });

  // Limpiar respuestas sincronizadas antiguas (más de 7 días)
  ipcMain.handle('fiscal-cleanup-old-responses', async () => {
    try {
      const responses = loadFiscalResponses(app);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      
      const filtered = responses.filter(r => {
        if (!r.syncedToBackend) return true;
        const createdAt = new Date(r.createdAt);
        return createdAt > sevenDaysAgo;
      });
      
      const removed = responses.length - filtered.length;
      saveFiscalResponses(app, filtered);
      
      return { success: true, removed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Enviar reporte X
  ipcMain.handle('fiscal-send-report-x', async () => {
    try {
      const config = loadFiscalConfig(app);
      console.log('[FISCAL] Report X requested. enabled:', config.enabled, 'fiscalMode:', config.fiscalMode, 'serverUrl:', config.serverUrl);
      
      if (!config.enabled || !config.fiscalMode) {
        console.log('[FISCAL] Report X simulated (non-fiscal mode)');
        return { success: true, message: 'Reporte X simulado (modo no fiscal)', simulated: true };
      }

      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal`, 'POST', {
        parametros: 'I0X',
        type: 'reportefiscal',
      });
      console.log('[FISCAL] Report X statusCode:', result.statusCode, 'data:', JSON.stringify(result.data));

      if (result.statusCode === 409) {
        return { success: true, message: 'Reporte X ya fue enviado previamente (duplicado)', duplicated: true };
      }
      if (result.statusCode === 200 && result.data?.status === 'ok') {
        return { success: true, message: 'Reporte X enviado a la cola', job_id: result.data.job_id };
      }
      return { success: false, error: result.data?.message || 'Error al enviar Reporte X' };
    } catch (error) {
      console.error('[FISCAL] Report X error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Enviar reporte Z
  ipcMain.handle('fiscal-send-report-z', async () => {
    try {
      const config = loadFiscalConfig(app);
      console.log('[FISCAL] Report Z requested. enabled:', config.enabled, 'fiscalMode:', config.fiscalMode, 'serverUrl:', config.serverUrl);
      
      if (!config.enabled || !config.fiscalMode) {
        console.log('[FISCAL] Report Z simulated (non-fiscal mode)');
        return { success: true, message: 'Reporte Z simulado (modo no fiscal)', simulated: true };
      }

      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal`, 'POST', {
        parametros: 'I0Z',
        type: 'reportefiscal',
      });
      console.log('[FISCAL] Report Z statusCode:', result.statusCode, 'data:', JSON.stringify(result.data));

      if (result.statusCode === 409) {
        return { success: true, message: 'Reporte Z ya fue enviado previamente (duplicado)', duplicated: true };
      }
      if (result.statusCode === 200 && result.data?.status === 'ok') {
        return { success: true, message: 'Reporte Z enviado a la cola', job_id: result.data.job_id };
      }
      return { success: false, error: result.data?.message || 'Error al enviar Reporte Z' };
    } catch (error) {
      console.error('[FISCAL] Report Z error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Documento NO FISCAL (presupuesto / comprobante interno). Recibe un array de
  // líneas de texto ya formateadas; el server las envuelve en 80/81/82. NO asigna
  // número fiscal ni afecta la memoria fiscal.
  ipcMain.handle('fiscal-print-non-fiscal', async (event, payload) => {
    try {
      const config = loadFiscalConfig(app);
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }
      const lines = Array.isArray(payload?.lines) ? payload.lines : [];
      if (lines.length === 0) {
        return { success: false, error: 'Documento no fiscal vacío' };
      }
      if (!config.fiscalMode) {
        console.log('[FISCAL] Documento no fiscal simulado (modo no fiscal)');
        return { success: true, message: 'Documento no fiscal simulado (modo no fiscal)', simulated: true };
      }
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal`, 'POST', {
        parametros: lines,
        type: 'documentonofiscal',
      });
      console.log('[FISCAL] Documento no fiscal statusCode:', result.statusCode, 'data:', JSON.stringify(result.data));
      if (result.statusCode === 409) {
        return { success: true, message: 'Documento no fiscal ya fue enviado (duplicado)', duplicated: true };
      }
      if (result.statusCode === 200 && result.data?.status === 'ok') {
        return { success: true, message: 'Documento no fiscal enviado a la cola', job_id: result.data.job_id };
      }
      return { success: false, error: result.data?.message || 'Error al imprimir documento no fiscal' };
    } catch (error) {
      console.error('[FISCAL] Documento no fiscal error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Configurar puerto COM
  ipcMain.handle('fiscal-set-port', async (event, comPort) => {
    try {
      console.log('[FISCAL] Setting COM port:', comPort);
      
      const config = loadFiscalConfig(app);
      config.comPort = comPort;
      config.lastConfigUpdate = new Date().toISOString();
      saveFiscalConfig(app, config);
      
      console.log('[FISCAL] COM port saved to local config');
      
      // Enviar configuración al servidor fiscal para actualizar Puerto.dat
      console.log('[FISCAL] Sending COM port to server:', config.serverUrl);
      try {
        const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/config/puerto`, 'POST', {
          puerto: comPort
        });
        console.log('[FISCAL] Server response:', JSON.stringify(result.data));
        
        if (result.data?.status === 'ok') {
          console.log('[FISCAL] Puerto.dat updated successfully:', result.data.archivo_puerto);
          return { success: true, comPort, serverUpdated: true };
        } else {
          console.warn('[FISCAL] Server returned error:', result.data?.message);
          return { success: true, comPort, serverUpdated: false, serverError: result.data?.message };
        }
      } catch (serverError) {
        console.warn('[FISCAL] Could not configure COM port in server:', serverError.message);
        return { success: true, comPort, serverUpdated: false, serverError: serverError.message };
      }
    } catch (error) {
      console.error('[FISCAL] Error setting COM port:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Probar conexión con impresora fiscal
  ipcMain.handle('fiscal-test-printer', async () => {
    try {
      const config = loadFiscalConfig(app);
      
      console.log('[FISCAL] Test printer requested');
      console.log('[FISCAL] Config:', JSON.stringify({
        enabled: config.enabled,
        fiscalMode: config.fiscalMode,
        comPort: config.comPort,
        serverUrl: config.serverUrl,
      }));
      
      if (!config.enabled) {
        console.log('[FISCAL] Test printer: Máquina fiscal no habilitada');
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }

      if (!config.fiscalMode) {
        console.log('[FISCAL] Test printer: Modo no fiscal - simulando');
        return { success: true, message: 'Test simulado (modo no fiscal)', simulated: true, printer_connected: true };
      }

      console.log('[FISCAL] Test printer: Sending request to', `${config.serverUrl}/fiscal/test-printer`);
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/test-printer`, 'POST');
      
      console.log('[FISCAL] Test printer response:');
      console.log('[FISCAL]   - statusCode:', result.statusCode);
      console.log('[FISCAL]   - data:', JSON.stringify(result.data, null, 2));
      
      return {
        success: result.data?.status === 'ok',
        ...result.data,
      };
    } catch (error) {
      console.error('[FISCAL] Test printer error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Imprime una factura de prueba (1 producto exento, 1 Bs, efectivo)
  // GENERA UN DOCUMENTO FISCAL REAL con número consecutivo.
  ipcMain.handle('fiscal-test-print', async () => {
    try {
      const config = loadFiscalConfig(app);

      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }

      if (!config.fiscalMode) {
        return { success: false, error: 'Activa el modo fiscal para imprimir una prueba real' };
      }

      console.log('[FISCAL] Sending test print to', `${config.serverUrl}/fiscal/test-print`);
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/test-print`, 'POST');
      console.log('[FISCAL] Test print response:', JSON.stringify(result.data, null, 2));
      return {
        success: result.data?.status === 'ok',
        ...result.data,
      };
    } catch (error) {
      console.error('[FISCAL] Test print error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Imprime una factura de prueba CON código de barras, para validar el formato
  // del comando 'Y' contra el HKA80 real antes de activarlo en producción.
  // Recibe { type, format } para poder probar 'typed' vs 'plain' sin guardar config.
  // GENERA UN DOCUMENTO FISCAL REAL con número consecutivo.
  ipcMain.handle('fiscal-test-barcode', async (event, opts = {}) => {
    try {
      const config = loadFiscalConfig(app);

      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }

      // Permitimos probar en modo NO fiscal: esos documentos salen marcados
      // "NO FISCAL" y NO consumen correlativo fiscal, así iteramos el comando
      // de barra sin gastar números. isFiscalMode controla ese indicador.
      const isFiscalMode = config.fiscalMode === true;

      // Código de ejemplo alfanumérico (simula el segmento final de un UUID).
      const sampleCode = 'TEST12AB34CD';
      const invoiceData = {
        type: 'factura',
        orderUuid: `barcode-test-${Date.now()}`,
        orderNumber: sampleCode,
        cashRegisterNumber: config.cashRegisterNumber || '',
        products: [
          { description: 'PRUEBA CODIGO BARRA', price: 1, quantity: 1, taxType: 'exento' },
        ],
        paymentType: '101',
      };

      const barcodeOpts = {
        enabled: true,
        // Línea a probar (ej. 'j21{code}'); {code} se reemplaza por el código.
        raw: opts.rawLine || config.barcodeRaw || null,
      };

      console.log('[FISCAL] Test barcode | fiscalMode:', isFiscalMode, '| opts:', barcodeOpts);
      const result = await sendFiscalInvoice(config.serverUrl, invoiceData, isFiscalMode, barcodeOpts);
      return { success: result.success === true || result.status === 'ok', ...result };
    } catch (error) {
      console.error('[FISCAL] Test barcode error:', error.message);
      return { success: false, error: error.message };
    }
  });

  // Obtener configuración completa del servidor fiscal
  ipcMain.handle('fiscal-get-server-config', async () => {
    try {
      const config = loadFiscalConfig(app);
      
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }

      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/config`, 'GET');
      return {
        success: result.statusCode === 200,
        ...result.data,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Estado decodificado de la impresora (GET /fiscal/status): esperando, sin papel,
  // memoria llena, en transacción, etc. Sirve para mostrar estado en vivo en la config.
  ipcMain.handle('fiscal-get-status', async () => {
    try {
      const config = loadFiscalConfig(app);
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/status`, 'GET');
      return { success: result.data?.status === 'ok', ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Datos de la máquina fiscal (GET /fiscal/s1): RIF, serial registrado, contadores,
  // fecha/hora. Permite autocompletar el serial leyéndolo de la impresora.
  ipcMain.handle('fiscal-get-machine-data', async () => {
    try {
      const config = loadFiscalConfig(app);
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/s1`, 'GET');
      return { success: result.data?.status === 'ok', ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Lista las operaciones de prueba disponibles (Fijas del Fiscalizador).
  ipcMain.handle('fiscal-list-operations', async () => {
    try {
      const config = loadFiscalConfig(app);
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }
      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal/operations`, 'GET');
      return { success: result.data?.status === 'ok', ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Ejecuta una operación de prueba. OJO: emite un documento fiscal REAL.
  ipcMain.handle('fiscal-run-operation', async (event, name) => {
    try {
      const config = loadFiscalConfig(app);
      if (!config.enabled) {
        return { success: false, error: 'Máquina fiscal no habilitada' };
      }
      const url = `${config.serverUrl}/fiscal/operation/${encodeURIComponent(name)}`;
      const result = await makeFiscalRequest(url, 'POST');
      return { success: result.data?.status === 'ok', ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ==================== FISCAL SERVER MANAGEMENT ====================

  // Obtener estado del servidor fiscal Python
  ipcMain.handle('fiscal-server-status', async () => {
    try {
      const status = await getServerStatus();
      return { success: true, ...status };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Iniciar servidor fiscal Python
  ipcMain.handle('fiscal-server-start', async (event, options = {}) => {
    try {
      const result = await startFiscalServer(options);
      if (result.success) {
        saveFiscalConfig(app, { serverEnabled: true });
      }
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Detener servidor fiscal Python
  ipcMain.handle('fiscal-server-stop', async () => {
    try {
      stopFiscalServer();
      saveFiscalConfig(app, { serverEnabled: false });
      return { success: true, message: 'Server stopped' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Reiniciar servidor fiscal Python
  ipcMain.handle('fiscal-server-restart', async (event, options = {}) => {
    try {
      const result = await restartFiscalServer(options);
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Verificar si Python está disponible (embebido empaquetado o del sistema)
  // Devuelve además la versión para mostrarla en la UI.
  ipcMain.handle('fiscal-check-python', async () => {
    try {
      const info = await getPythonInfo();
      return { success: true, ...info };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log('[FISCAL] Handlers registered successfully');
};

module.exports = {
  registerFiscalHandlers,
  // Builders puros expuestos para pruebas (no tocan IPC ni disco).
  buildCloseLines,
  generateFiscalContent,
  generateCreditNoteContent,
};
