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
      const data = fs.readFileSync(configPath, 'utf-8');
      return { ...DEFAULT_FISCAL_CONFIG, ...JSON.parse(data) };
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
      const data = fs.readFileSync(responsesPath, 'utf-8');
      return JSON.parse(data);
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
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 3000,
      path: urlObj.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 30000, // 30 segundos
    };

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
    return { connected: result.statusCode === 200, data: result.data };
  } catch (error) {
    return { connected: false, error: error.message };
  }
};

// Enviar factura al servidor fiscal
const sendFiscalInvoice = async (serverUrl, invoiceData) => {
  try {
    // Generar contenido del archivo fiscal
    const fiscalLines = generateFiscalContent(invoiceData);
    
    const requestData = {
      parametros: fiscalLines,
      type: invoiceData.type || 'factura',
      file: 'Factura.txt',
    };

    console.log('[FISCAL] Sending invoice:', requestData);
    
    const result = await makeFiscalRequest(`${serverUrl}/fiscal`, 'POST', requestData);
    
    return {
      success: result.statusCode === 200 || result.statusCode === 201,
      ...result.data,
    };
  } catch (error) {
    console.error('[FISCAL] Error sending invoice:', error);
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
const generateFiscalContent = (invoiceData) => {
  const lines = [];
  
  // Línea de comentario con caja y número de orden
  const comment = `Caja: ${invoiceData.cashRegisterNumber || 'N/A'} - ${invoiceData.orderNumber || 'N/A'}`;
  lines.push(`i05${comment}`);
  lines.push('');
  
  // Productos - todos como exentos por defecto (espacio = exento)
  if (invoiceData.products && Array.isArray(invoiceData.products)) {
    for (const product of invoiceData.products) {
      // Formato: [TaxCode][Price(12)][Quantity(8)][Description]
      // Exento = espacio ' '
      const taxCode = ' '; // Exento por defecto
      
      // Precio en centavos (sin decimales), 12 dígitos
      const priceInCents = Math.round((product.price || 0) * 100);
      const priceStr = priceInCents.toString().padStart(12, '0');
      
      // Cantidad en milésimas, 8 dígitos
      const qtyInThousandths = Math.round((product.quantity || 1) * 1000);
      const qtyStr = qtyInThousandths.toString().padStart(8, '0');
      
      // Descripción: máximo 20 caracteres, sin caracteres especiales
      const description = (product.description || 'PRODUCTO')
        .substring(0, 20)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Eliminar acentos
        .replace(/[^\x20-\x7E]/g, ''); // Solo caracteres ASCII
      
      lines.push(`${taxCode}${priceStr}${qtyStr}${description}`);
      lines.push('');
    }
  }
  
  // Cierre: 101 = efectivo
  lines.push('101');
  lines.push('');
  
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
      const url = serverUrl || config.serverUrl || 'http://localhost:3000';
      const result = await checkFiscalConnection(url);
      return { success: true, ...result };
    } catch (error) {
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

      // Si está en modo no fiscal, simular respuesta exitosa
      if (!config.fiscalMode) {
        console.log('[FISCAL] Non-fiscal mode - simulating success');
        const fakeJobId = `test-${Date.now()}`;
        
        // Guardar respuesta simulada
        const responses = loadFiscalResponses(app);
        responses.push({
          id: fakeJobId,
          orderUuid: invoiceData.orderUuid,
          orderNumber: invoiceData.orderNumber,
          storeCode: invoiceData.storeCode,
          cashRegisterNumber: invoiceData.cashRegisterNumber,
          documentType: invoiceData.type || 'factura',
          status: 'completed',
          simulated: true,
          createdAt: new Date().toISOString(),
          processedAt: new Date().toISOString(),
          syncedToBackend: false,
          syncAttempts: 0,
        });
        saveFiscalResponses(app, responses);

        return {
          success: true,
          message: 'Factura simulada (modo no fiscal)',
          job_id: fakeJobId,
          simulated: true,
        };
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
      
      if (!config.enabled || !config.fiscalMode) {
        return { success: true, message: 'Reporte X simulado (modo no fiscal)', simulated: true };
      }

      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal`, 'POST', {
        parametros: 'I0X',
        type: 'reportefiscal',
      });

      return { success: result.statusCode === 200, ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Enviar reporte Z
  ipcMain.handle('fiscal-send-report-z', async () => {
    try {
      const config = loadFiscalConfig(app);
      
      if (!config.enabled || !config.fiscalMode) {
        return { success: true, message: 'Reporte Z simulado (modo no fiscal)', simulated: true };
      }

      const result = await makeFiscalRequest(`${config.serverUrl}/fiscal`, 'POST', {
        parametros: 'I0Z',
        type: 'reportefiscal',
      });

      return { success: result.statusCode === 200, ...result.data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Configurar puerto COM
  ipcMain.handle('fiscal-set-port', async (event, comPort) => {
    try {
      const config = loadFiscalConfig(app);
      config.comPort = comPort;
      config.lastConfigUpdate = new Date().toISOString();
      saveFiscalConfig(app, config);
      
      // Si estamos en modo fiscal, enviar comando al servidor
      if (config.fiscalMode && config.enabled) {
        // El servidor fiscal maneja el puerto internamente
        console.log('[FISCAL] COM port configured:', comPort);
      }
      
      return { success: true, comPort };
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
