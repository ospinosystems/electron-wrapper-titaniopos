/**
 * Handlers para comunicación con máquina fiscal HKA
 * Este módulo maneja la comunicación con el servidor fiscal y almacenamiento local
 */

const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { 
  startFiscalServer, 
  stopFiscalServer, 
  getServerStatus, 
  restartFiscalServer,
  checkPythonInstalled 
} = require('./fiscal-server-manager');

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

// Directorio para almacenar respuestas fiscales localmente
const getFiscalDataDir = (app) => {
  const documentsPath = app.getPath('documents');
  const fiscalDir = path.join(documentsPath, 'TitanioPOS-Fiscal');
  if (!fs.existsSync(fiscalDir)) {
    fs.mkdirSync(fiscalDir, { recursive: true });
  }
  return fiscalDir;
};

// Obtener archivo de configuración fiscal
const getFiscalConfigPath = (app) => {
  return path.join(getFiscalDataDir(app), 'fiscal-config.json');
};

// Obtener archivo de respuestas pendientes
const getFiscalResponsesPath = (app) => {
  return path.join(getFiscalDataDir(app), 'fiscal-responses.json');
};

// Cargar configuración fiscal
const loadFiscalConfig = (app) => {
  try {
    const configPath = getFiscalConfigPath(app);
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8').trim();
      if (data) {
        return { ...DEFAULT_FISCAL_CONFIG, ...JSON.parse(data) };
      }
    }
  } catch (error) {
    console.error('[FISCAL] Error loading config:', error);
  }
  return DEFAULT_FISCAL_CONFIG;
};

// Guardar configuración fiscal
const saveFiscalConfig = (app, config) => {
  try {
    const configPath = getFiscalConfigPath(app);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[FISCAL] Config saved:', configPath);
    return true;
  } catch (error) {
    console.error('[FISCAL] Error saving config:', error);
    return false;
  }
};

// Cargar respuestas fiscales pendientes
const loadFiscalResponses = (app) => {
  try {
    const responsesPath = getFiscalResponsesPath(app);
    if (fs.existsSync(responsesPath)) {
      const data = fs.readFileSync(responsesPath, 'utf-8').trim();
      if (data) {
        return JSON.parse(data);
      }
    }
  } catch (error) {
    console.error('[FISCAL] Error loading responses:', error);
  }
  return [];
};

// Guardar respuestas fiscales
const saveFiscalResponses = (app, responses) => {
  try {
    const responsesPath = getFiscalResponsesPath(app);
    fs.writeFileSync(responsesPath, JSON.stringify(responses, null, 2), 'utf-8');
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
const sendFiscalInvoice = async (serverUrl, invoiceData) => {
  try {
    const docType = invoiceData.type || 'factura';
    
    // Generar contenido según el tipo de documento
    let fiscalLines;
    if (docType === 'notacredito' || docType === 'creditnote') {
      fiscalLines = generateCreditNoteContent(invoiceData);
    } else {
      fiscalLines = generateFiscalContent(invoiceData);
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
const generateFiscalContent = (invoiceData) => {
  const lines = [];
  
  // Datos del cliente (opcional)
  if (invoiceData.customerName) {
    // iS* = Nombre del cliente
    const customerName = sanitizeText(invoiceData.customerName, 40);
    lines.push(`iS*${customerName}`);
  }
  
  if (invoiceData.customerRif) {
    // iR* = RIF/Cédula del cliente
    const customerRif = invoiceData.customerRif.replace(/[^0-9A-Za-z]/g, '');
    lines.push(`iR*${customerRif}`);
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
      
      // Precio en centavos (sin decimales), 12 dígitos
      // IMPORTANTE: Es el precio UNITARIO, no el total
      const priceInCents = Math.round((product.price || 0) * 100);
      const priceStr = priceInCents.toString().padStart(12, '0');
      
      // Cantidad en milésimas, 8 dígitos (ej: 1.000 = 00001000)
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');
      
      // Descripción: máximo 20 caracteres, sin caracteres especiales
      const description = sanitizeText(product.description || 'PRODUCTO', 20);
      
      // Formato final: [TasaIVA][Precio12][Cantidad8][Descripción]
      lines.push(`${taxCode}${priceStr}${qtyStr}${description}`);
    }
  }
  
  // Cierre de factura - tipo de pago
  // 101 = Efectivo
  // 102 = Débito
  // 103 = Crédito
  // 104 = Otros
  // 199 = Sin pago (solo para cierres sin monto)
  const paymentType = invoiceData.paymentType || '101';
  lines.push(paymentType);
  
  return lines;
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
  
  // Comentario de la nota de crédito (opcional)
  if (creditNoteData.comment) {
    const comment = sanitizeText(creditNoteData.comment, 40);
    lines.push(`A${comment}`);
  }
  
  // Línea de referencia con caja y número de orden
  const orderComment = `Caja: ${creditNoteData.cashRegisterNumber || 'N/A'} - ${creditNoteData.orderNumber || 'N/A'}`;
  lines.push(`i05${orderComment}`);
  
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
      
      // Precio en centavos, 12 dígitos
      const priceInCents = Math.round((product.price || 0) * 100);
      const priceStr = priceInCents.toString().padStart(12, '0');
      
      // Cantidad en milésimas, 8 dígitos
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');
      
      // Descripción
      const description = sanitizeText(product.description || 'PRODUCTO', 20);
      
      // Formato: d[TasaIVA][Precio][Cantidad][Descripción]
      lines.push(`d${taxCode}${priceStr}${qtyStr}${description}`);
    }
  }
  
  // Cierre
  const paymentType = creditNoteData.paymentType || '101';
  lines.push(paymentType);
  
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
      if (!config.fiscalMode) {
        console.log('[FISCAL] Non-fiscal mode - printing but marking as simulated');
      }

      // Modo fiscal real
      const result = await sendFiscalInvoice(config.serverUrl, {
        ...invoiceData,
        cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
      });

      if (result.success && result.job_id) {
        // Guardar respuesta pendiente
        const responses = loadFiscalResponses(app);
        responses.push({
          id: result.job_id,
          orderUuid: invoiceData.orderUuid,
          orderNumber: invoiceData.orderNumber,
          storeCode: invoiceData.storeCode,
          cashRegisterNumber: invoiceData.cashRegisterNumber || config.cashRegisterNumber,
          documentType: invoiceData.type || 'factura',
          status: 'pending',
          createdAt: new Date().toISOString(),
          syncedToBackend: false,
          syncAttempts: 0,
        });
        saveFiscalResponses(app, responses);
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
            responses[idx].response = result;
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

  // Marcar error de sincronización
  ipcMain.handle('fiscal-mark-sync-error', async (event, responseId, errorMessage) => {
    try {
      const responses = loadFiscalResponses(app);
      const idx = responses.findIndex(r => r.id === responseId);
      if (idx !== -1) {
        responses[idx].syncAttempts = (responses[idx].syncAttempts || 0) + 1;
        responses[idx].lastSyncAttempt = new Date().toISOString();
        responses[idx].syncError = errorMessage;
        saveFiscalResponses(app, responses);
        return { success: true };
      }
      return { success: false, error: 'Response not found' };
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
      return result;
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Detener servidor fiscal Python
  ipcMain.handle('fiscal-server-stop', async () => {
    try {
      stopFiscalServer();
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

  // Verificar si Python está instalado
  ipcMain.handle('fiscal-check-python', async () => {
    try {
      const result = await checkPythonInstalled();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  console.log('[FISCAL] Handlers registered successfully');
};

module.exports = { registerFiscalHandlers };
