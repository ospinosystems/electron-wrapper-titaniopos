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
const sendFiscalInvoice = async (serverUrl, invoiceData, fiscalMode = true, barcodeOpts = null) => {
  try {
    const docType = invoiceData.type || 'factura';

    // Generar contenido según el tipo de documento
    let fiscalLines;
    if (docType === 'notacredito' || docType === 'creditnote') {
      fiscalLines = generateCreditNoteContent(invoiceData);
    } else {
      fiscalLines = generateFiscalContent(invoiceData, barcodeOpts);
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
  return String(opts.raw).includes('{code}')
    ? String(opts.raw).replace('{code}', clean)
    : String(opts.raw);
};

const generateFiscalContent = (invoiceData, barcodeOpts = null) => {
  const lines = [];
  
  // Datos del cliente (opcional)
  // Soporta tanto customerName/customerRif como client.name/client.rif
  const clientName = invoiceData.customerName || (invoiceData.client && invoiceData.client.name);
  const clientRif = invoiceData.customerRif || (invoiceData.client && invoiceData.client.rif);
  
  if (clientName) {
    // iS* = Nombre del cliente
    const sanitizedName = sanitizeText(clientName, 40);
    lines.push(`iS*${sanitizedName}`);
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
  if (invoiceData.products && Array.isArray(invoiceData.products)) {
    for (const product of invoiceData.products) {
      // Código de tasa IVA:
      // ' ' (espacio) = Exento (0%)
      // '!' = Tasa General (16%)
      // '"' = Tasa Reducida (8%)
      // '#' = Tasa Adicional (31%)
      let taxCode = ' '; // Exento por defecto
      
      if (product.taxRate !== undefined) {
        if (product.taxRate >= 15) {
          taxCode = '!'; // Tasa General
        } else if (product.taxRate >= 7 && product.taxRate < 15) {
          taxCode = '"'; // Tasa Reducida
        } else if (product.taxRate > 20) {
          taxCode = '#'; // Tasa Adicional
        }
      }
      
      // Precio en centavos (sin decimales), 10 dígitos
      // IMPORTANTE: Es el precio UNITARIO, no el total
      // OJO HKA80: el precio es de 10 dígitos. Con 12 la impresora lee mal
      // los campos y sale 0.01 x 0.01. Verificado con hardware real.
      const priceNum = parseFloat(product.price) || 0;
      const priceInCents = Math.round(priceNum * 100);
      const priceStr = priceInCents.toString().padStart(10, '0');

      // Cantidad en milésimas, 8 dígitos (ej: 1.000 = 00001000)
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');

      // Descripción: en la línea del ítem solo caben 20 caracteres; el resto sale en
      // líneas '@' debajo, para que el producto se lea completo (ver
      // buildDescriptionOverflowLines).
      const fullDescription = sanitizeText(product.description || 'PRODUCTO', 200);
      const { itemDesc, extraLines } = buildProductDescLines(fullDescription);

      // Formato final: [TasaIVA][Precio10][Cantidad8][Descripción]
      // El nombre va SOLO en la línea del ítem (la HKA lo recorta a su ancho). Se
      // eliminaron las líneas '@' de continuación del nombre porque la HKA las enmarca
      // con '|' (se veía cargado) y separaban el descuento de su producto. El nombre
      // queda recortado a propósito (elección de caja).
      void extraLines;
      const productLine = `${taxCode}${priceStr}${qtyStr}${itemDesc}`;
      console.log(`[FISCAL] Product line: price=${product.price} -> "${priceStr}" | qty=${product.quantity} -> "${qtyStr}" | LINE="${productLine}"`);
      lines.push(productLine);
      // Descuento (informativo) JUSTO debajo del ítem, CON IVA. No toca el cálculo fiscal.
      const descLine = buildDiscountLine(product.listPrice, product.price, product.quantity, product.taxRate);
      if (descLine) lines.push(descLine);
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
  for (const line of buildCloseLines(invoiceData)) {
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
const buildCloseLines = (invoiceData) => {
  const payments = Array.isArray(invoiceData.payments) ? invoiceData.payments : [];

  const normCode = (c, fallback) => {
    const digits = String(c ?? '').replace(/\D/g, '');
    return digits.length ? digits.padStart(2, '0').slice(-2) : fallback;
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
    const isDivisa = (p) => {
      const n = parseInt(normCode(p.code, '04'), 10);
      return n >= 20 && n <= 24;
    };
    const ordered = [...payments].sort((a, b) => Number(isDivisa(b)) - Number(isDivisa(a)));
    const closer = ordered[ordered.length - 1];
    closeLines = ordered.slice(0, -1).map((p) => {
      const code = normCode(p.code, '04'); // sin código claro → "otros"
      const cents = Math.max(0, Math.round((parseFloat(p.amountBs) || 0) * 100));
      const amountStr = cents.toString().padStart(12, '0');
      return `2${code}${amountStr}`;
    });
    closeLines.push(`1${normCode(closer.code, '01')}`);
  }

  // '199' = cerrar/finalizar el documento (corta el papel). SIN esto la HKA80
  // paga pero deja la factura a la mitad y no corta (validado en hardware).
  closeLines.push('199');
  return closeLines;
};

// La línea del ítem solo admite 20 caracteres de descripción, así que un nombre
// largo salía cortado en la factura. El resto se imprime en líneas adicionales con
// el comando '@' (texto libre en el cuerpo del documento). Validado contra la
// máquina: la prueba op:factura-cliente de THE FACTORY intercala '@PRUEBA DESDE
// TITANIOPOS' entre los ítems y la HKA la ACKea.
const ITEM_DESC_LEN = 20;   // lo que cabe en la propia línea del producto
const EXTRA_LINE_LEN = 40;  // ancho del papel para las líneas '@'

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

// Sin sangría en la continuación: la HKA ya enmarca las líneas '@' entre '|', y
// agregarle espacios se veía peor. El texto de continuación va pegado a la izquierda.
const CONT_INDENT = '';

/**
 * Parte la descripción del producto: `itemDesc` (≤20, va en la línea del ítem junto
 * al precio) y `extraLines` (el resto como líneas '@' SANGRADAS). El ancho de la
 * continuación descuenta la sangría para no pasarse del papel (40).
 */
const buildProductDescLines = (fullDescription) => {
  const wrapped = wrapWords(fullDescription, ITEM_DESC_LEN, EXTRA_LINE_LEN - CONT_INDENT.length);
  return {
    itemDesc: wrapped[0] || 'PRODUCTO',
    extraLines: wrapped.slice(1).map((l) => `@${CONT_INDENT}${l}`),
  };
};

/** Monto en Bs con separador de miles y 2 decimales (es-VE: 1.234,56). */
const fmtBs = (n) =>
  (Number(n) || 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Línea '@' informativa del DESCUENTO de un producto. El precio de lista y el precio
 * cobrado se calculan afuera; acá solo se imprime. Se muestra como texto y NO afecta
 * el cálculo fiscal (la línea del ítem ya lleva el precio descontado, lo que mantiene
 * el total exacto al céntimo). Devuelve null si no hay descuento.
 * `listUnit` y `paidUnit` son el precio UNITARIO de lista y el cobrado, en Bs.
 */
const buildDiscountLine = (listUnit, paidUnit, qty, taxRate = 0) => {
  // Se muestra CON IVA: es lo que percibe el cliente (la línea del ítem va en base
  // sin IVA porque la HKA suma el impuesto aparte, pero el ahorro que "siente" el
  // cliente es sobre el precio final con IVA). factor = 1 + alícuota.
  const f = 1 + (Number(taxRate) || 0) / 100;
  const list = (Number(listUnit) || 0) * f;
  const paid = (Number(paidUnit) || 0) * f;
  if (list <= paid + 0.005) return null; // sin descuento
  const descTotal = (list - paid) * (Number(qty) || 1);
  return `@${CONT_INDENT}Lista ${fmtBs(list)}  Ahorro -${fmtBs(descTotal)}`;
};

// Función auxiliar para limpiar texto (eliminar acentos y caracteres especiales)
const sanitizeText = (text, maxLength = 20) => {
  return (text || '')
    .substring(0, maxLength)
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
const generateCreditNoteContent = (creditNoteData) => {
  const lines = [];
  
  // Datos del cliente (requeridos para nota de crédito)
  if (creditNoteData.customerRif) {
    const customerRif = creditNoteData.customerRif.replace(/[^0-9A-Za-z]/g, '');
    lines.push(`iR*${customerRif}`);
  }
  
  if (creditNoteData.customerName) {
    const customerName = sanitizeText(creditNoteData.customerName, 40);
    lines.push(`iS*${customerName}`);
  }
  
  // Datos de la factura original (requeridos)
  if (creditNoteData.originalInvoiceNumber) {
    // Formato: 11 dígitos con ceros a la izquierda
    const invoiceNum = creditNoteData.originalInvoiceNumber.toString().padStart(11, '0');
    lines.push(`iF*${invoiceNum}`);
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
  if (creditNoteData.products && Array.isArray(creditNoteData.products)) {
    for (const product of creditNoteData.products) {
      let taxCode = '0'; // Exento por defecto
      
      if (product.taxRate !== undefined) {
        if (product.taxRate >= 15) {
          taxCode = '1'; // Tasa General
        } else if (product.taxRate >= 7 && product.taxRate < 15) {
          taxCode = '2'; // Tasa Reducida
        } else if (product.taxRate > 20) {
          taxCode = '3'; // Tasa Adicional
        }
      }
      
      // Precio en centavos, 10 dígitos (formato HKA80, ver generateFiscalContent)
      const priceInCents = Math.round((product.price || 0) * 100);
      const priceStr = priceInCents.toString().padStart(10, '0');
      
      // Cantidad en milésimas, 8 dígitos
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');
      
      // Descripción: igual que la factura (1ª línea 20 + continuación sangrada).
      const fullDescription = sanitizeText(product.description || 'PRODUCTO', 200);
      const { itemDesc, extraLines } = buildProductDescLines(fullDescription);

      // Formato: d[TasaIVA][Precio][Cantidad][Descripción]. Nombre solo en la línea del
      // ítem (sin líneas '@' de continuación → sin '|'), igual que la factura.
      void extraLines;
      lines.push(`d${taxCode}${priceStr}${qtyStr}${itemDesc}`);
      // Descuento (informativo) JUSTO debajo del ítem, CON IVA.
      const descLine = buildDiscountLine(product.listPrice, product.price, product.quantity, product.taxRate);
      if (descLine) lines.push(descLine);
    }
  }
  
  // Cierre (mismo contrato que la factura: reversa el IGTF si el pago era divisa)
  for (const line of buildCloseLines(creditNoteData)) {
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

      // Enviar factura (pasando fiscalMode para agregar indicador si es prueba).
      // Para NOTA DE CRÉDITO, el serial de la máquina (iI*) sale de la config si
      // el frontend no lo envió — es un dato fijo de la caja.
      const result = await sendFiscalInvoice(config.serverUrl, {
        ...invoiceData,
        cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
        originalPrinterSerial: invoiceData.originalPrinterSerial || config.machineSerial || undefined,
      }, isFiscalMode, barcodeOpts);

      if (result.success) {
        // Guardar respuesta con los datos del resultado del servidor fiscal
        const responses = loadFiscalResponses(app);
        const jobId = result.job_id || `local-${Date.now()}`;
        
        // El resultado puede incluir la respuesta directa de hka_serial
        const fiscalResponse = result.result || result;
        
        responses.push({
          id: jobId,
          orderUuid: invoiceData.orderUuid,
          orderNumber: invoiceData.orderNumber,
          storeCode: invoiceData.storeCode,
          cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
          documentType: invoiceData.type || 'factura',
          status: result.status === 'ok' ? 'completado' : 'pending',
          response: fiscalResponse,
          createdAt: new Date().toISOString(),
          processedAt: result.status === 'ok' ? new Date().toISOString() : undefined,
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
