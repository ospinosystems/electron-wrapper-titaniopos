/**
 * TitanioPOS - Printer IPC Handlers
 * 
 * This module provides IPC handlers for printer configuration and printing.
 * It integrates the printer configuration and printing methods modules.
 */

const { ipcMain } = require('electron');
const printerConfig = require('./printer-config');
const printerMethods = require('./printer-methods');
const { printWithDirect, printRawBufferDirect, ensureHelper } = require('./printer-direct');
const { readSettings, writeSettings, normalizeLabelPrinter } = require('./titaniopos-settings-file');

function buildSampleDispatchLabelPayload(now = new Date()) {
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return {
    kind: 'dispatch_order_label',
    order_uuid: '00000000-0000-4000-8000-000000000001',
    order_code: '#PRUEBA01',
    verify_url: 'https://ecommerce.titanio-pos.com/v/00000000-0000-4000-8000-000000000001',
    shipping_mode: 'DELIVERY',
    date: `${dd}/${mm}/${yyyy}`,
    customer_name: 'Prueba Etiqueta Titanio Store',
    customer_phone: '0414-000-0000',
    address_line: 'Av. Principal · Etiqueta 58x44 mm TSPL',
    store_name: 'Guacara',
    items_count: 1,
    paid_label: 'PRUEBA · TSPL',
    package_total: 1,
    package_index: 1,
  };
}

async function printTsplDispatchLabel(app, payload, overrides = {}, deps = {}) {
  const labelCfg = normalizeLabelPrinter(readSettings(app).labelPrinter);
  const printerName = String(overrides.printerName || labelCfg.printerName || '').trim();
  if (!printerName) {
    return { success: false, error: 'Impresora de etiquetas no configurada.' };
  }
  const variant = overrides.variant || labelCfg.variant || 'oficial';
  const renderer = deps.renderer || require('./tspl-label-renderer');
  const sendRaw = deps.printRawBufferDirect || printRawBufferDirect;
  const buffers = await renderer.renderDispatchTsplBuffers(payload, { variant });
  for (const buf of buffers) {
    await sendRaw(app, printerName, buf);
  }
  return {
    success: true,
    method: 'TSPL RAW (winspool)',
    variant,
    printed: buffers.length,
  };
}

/**
 * Imprime en la térmica LOCAL con la config guardada (impresora/método).
 * Punto único usado por el IPC 'printer-print' y por el servidor de impresión
 * en red (print-share.js) cuando otra caja manda un ticket.
 */
async function printWithConfiguredPrinter(app, content) {
  const config = printerConfig.loadConfig();

  if (!config.printerName) {
    return {
      success: false,
      error: 'Printer not configured. Please configure printer in settings.'
    };
  }

  // Priority: direct (fastest) > escpos > native (slowest)
  let effectiveMethod = config.method;
  if (effectiveMethod !== 'native' && effectiveMethod !== 'escpos' && effectiveMethod !== 'direct') {
    effectiveMethod = 'escpos';
  }

  // Auto-upgrade to direct if helper is available and method is escpos
  let useDirect = false;
  if (effectiveMethod === 'escpos' || effectiveMethod === 'direct') {
    const exePath = await ensureHelper(app);
    if (exePath) {
      useDirect = true;
      effectiveMethod = 'direct';
    }
  }

  console.log(`🖨️ [PRINT] Using method: ${effectiveMethod}`);

  let result;
  if (effectiveMethod === 'native') {
    // Impresora normal/digital (no térmica): el ticket va a hoja completa
    // (A4), no al rollo continuo 80mm×200mm de las térmicas.
    result = await printerMethods.printWithNativeAPI(
      app,
      config.printerName,
      content,
      config.paperWidth,
      { debugPdf: config.debugPdf === true, fullPage: true }
    );
  } else if (useDirect) {
    try {
      result = await printWithDirect(app, config.printerName, content);
    } catch (directErr) {
      if (directErr.timedOut) {
        // La impresora no responde: el fallback ESC/POS escribe al mismo puerto
        // y se quedaria esperando otros 15 s. Fallar ya, con mensaje claro.
        return { success: false, error: directErr.message, timedOut: true };
      }
      console.warn('⚠️ [PRINT] Direct method failed, falling back to ESC/POS:', directErr.message);
      result = await printerMethods.printWithESCPOS(
        app,
        config.printerName,
        content,
        config.usbPort
      );
    }
  } else {
    result = await printerMethods.printWithESCPOS(
      app,
      config.printerName,
      content,
      config.usbPort
    );
  }

  return result;
}

/**
 * Register all printer-related IPC handlers
 * @param {Electron.App} app - Electron app instance
 * @param {Electron.BrowserWindow} mainWindow - Main window instance
 */
function registerPrinterHandlers(app, mainWindow) {
  // Pre-compile direct helper on startup (non-blocking)
  ensureHelper(app).then((exePath) => {
    if (exePath) {
      console.log('✅ [PRINTER] Direct helper ready:', exePath);
    } else {
      console.log('⚠️ [PRINTER] Direct helper unavailable, will use PowerShell fallback');
    }
  });

  // ==================== CONFIGURATION HANDLERS ====================
  
  /**
   * Get current printer configuration
   */
  ipcMain.handle('printer-config-get', async () => {
    try {
      const config = printerConfig.loadConfig();
      return { success: true, config };
    } catch (error) {
      console.error('❌ [PRINTER CONFIG] Error getting config:', error);
      return { success: false, error: error.message };
    }
  });
  
  /**
   * Save printer configuration
   */
  ipcMain.handle('printer-config-save', async (event, config) => {
    try {
      // Validate configuration
      const validation = printerConfig.validateConfig(config);
      if (!validation.valid) {
        return { 
          success: false, 
          error: 'Invalid configuration', 
          errors: validation.errors 
        };
      }
      
      // Save configuration
      const result = printerConfig.saveConfig(config);
      return result;
    } catch (error) {
      console.error('❌ [PRINTER CONFIG] Error saving config:', error);
      return { success: false, error: error.message };
    }
  });
  
  /**
   * Get list of available printers
   */
  ipcMain.handle('printer-list', async () => {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      return { success: true, printers };
    } catch (error) {
      console.error('❌ [PRINTER] Error listing printers:', error);
      return { success: false, error: error.message };
    }
  });
  
  // ==================== PRINTING HANDLERS ====================
  
  /**
   * Print using configured method
   * Automatically uses the method specified in configuration
   */
  ipcMain.handle('printer-print', async (event, content, options = {}) => {
    try {
      // Impresión en red: si esta caja usa la impresora de otra (modo receive),
      // el ticket se reenvía por HTTP a la caja anfitriona y se imprime allá.
      // Lazy require: print-share también requiere este módulo.
      const printShare = require('./print-share');
      const remote = printShare.getRemoteTicketTarget(app);
      if (remote) {
        console.log(`🖨️ [PRINT] Reenviando a caja anfitriona ${remote.hostIp}:${remote.hostPort}`);
        return await printShare.sendRemotePrint(remote, content, options);
      }

      return await printWithConfiguredPrinter(app, content);
    } catch (error) {
      console.error('❌ [PRINT] Error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Vacía la cola de Windows de la tickera configurada. La vista lo pide al
   * confirmar el cierre de caja (Electron lo hace solo al arrancar). Borra
   * únicamente trabajos más viejos que `olderThanSeconds` (default 30 s) para
   * no tocar un ticket que esté saliendo en ese momento. Nunca lanza.
   */
  ipcMain.handle('printer-purge-queue', async (event, options = {}) => {
    const { purgeTicketPrinterQueue } = require('./printer-queue');
    const age = Number(options && options.olderThanSeconds);
    return purgeTicketPrinterQueue({ olderThanSeconds: Number.isFinite(age) ? age : 30 });
  });

  /**
   * Modo directo de la tickera a pedido (comando remoto `printer_direct_mode`
   * del bus): escribe printerDirectMode.enabled en el settings. La tarea SYSTEM
   * aplica el cambio en su siguiente pasada (arranque, inicio de sesión o cada
   * 2 h); la app no tiene permisos para tocar la impresora. Nunca lanza.
   */
  ipcMain.handle('printer-direct-mode-set', async (event, options = {}) => {
    const { setPrinterDirectMode } = require('./printer-direct-pilot');
    return setPrinterDirectMode(app, options && options.enabled);
  });

  /**
   * Imprime una ETIQUETA (HTML o payload TSPL) ruteando como printer-print: si
   * esta caja usa la impresora de etiquetas de otra (modo receive +
   * useRemoteLabel), viaja por HTTP a la anfitriona; si no, imprime local
   * (TSPL RAW cuando labelPrinter.method === 'tspl' o llega payload TSPL).
   */
  ipcMain.handle('printer-print-label', async (event, content) => {
    try {
      const isObj = Boolean(content && typeof content === 'object');
      const tsplPayload = isObj
        ? (content.format === 'tspl' && content.payload ? content.payload : content)
        : null;

      const printShare = require('./print-share');
      const remote = printShare.getRemoteLabelTarget(app);
      if (remote) {
        console.log(`🏷️ [PRINT] Etiqueta a caja anfitriona ${remote.hostIp}:${remote.hostPort}`);
        return await printShare.sendRemoteLabelPrint(
          remote,
          tsplPayload ? { format: 'tspl', payload: tsplPayload } : content
        );
      }

      const labelCfg = normalizeLabelPrinter(readSettings(app).labelPrinter);
      if (!labelCfg.printerName) {
        return { success: false, error: 'Impresora de etiquetas no configurada.' };
      }

      if (tsplPayload) {
        return await printTsplDispatchLabel(app, tsplPayload);
      }

      if (labelCfg.method === 'tspl') {
        const { renderHtmlToTsplBuffer } = require('./tspl-label-renderer');
        const buf = await renderHtmlToTsplBuffer(String(content || ''));
        await printRawBufferDirect(app, labelCfg.printerName, buf);
        return { success: true, method: 'TSPL RAW (winspool)', printed: 1 };
      }

      return await printerMethods.printWithNativeAPI(
        app,
        labelCfg.printerName,
        content,
        `${labelCfg.widthMm}mm`,
        { widthMm: labelCfg.widthMm, heightMm: labelCfg.heightMm }
      );
    } catch (error) {
      console.error('❌ [PRINT] Etiqueta:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Imprime etiqueta(s) de despacho 58×44 mm por TSPL RAW usando la impresora y
   * variante configuradas en labelPrinter (o la anfitriona si usa remota).
   */
  ipcMain.handle('printer-print-tspl-label', async (event, payload) => {
    try {
      if (!payload || typeof payload !== 'object') {
        return { success: false, error: 'Payload de etiqueta TSPL inválido.' };
      }
      const printShare = require('./print-share');
      const remote = printShare.getRemoteLabelTarget(app);
      if (remote) {
        console.log(`🏷️ [PRINT-TSPL] Etiqueta a caja anfitriona ${remote.hostIp}:${remote.hostPort}`);
        return await printShare.sendRemoteLabelPrint(remote, { format: 'tspl', payload });
      }
      return await printTsplDispatchLabel(app, payload);
    } catch (error) {
      console.error('❌ [PRINT-TSPL] Error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Espejo de la config de etiquetas del front hacia el settings unificado.
   * El main la necesita para poder imprimir etiquetas sin pasar por el
   * renderer (servidor de impresión en red). null NO borra: el espejo solo
   * acumula la última config real.
   */
  ipcMain.handle('label-printer-config-set', async (event, config) => {
    try {
      if (!config || typeof config !== 'object' || !config.printerName) {
        return { success: false, error: 'Config de etiquetas vacía.' };
      }
      const s = readSettings(app);
      const next = normalizeLabelPrinter({ ...s.labelPrinter, ...config, lastUpdated: new Date().toISOString() });
      if (JSON.stringify(s.labelPrinter) !== JSON.stringify(next)) {
        s.labelPrinter = next;
        writeSettings(app, s);
        console.log('🏷️ [PRINTER] Config de etiquetas espejada:', next.printerName);
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  /**
   * Test print with specific method
   * Used for testing during configuration
   */
  ipcMain.handle('printer-test', async (event, method, printerName, content, options = {}) => {
    try {
      console.log(`🖨️ [TEST] Testing method: ${method}`);
      
      let result;
      if (method === 'native') {
        result = await printerMethods.printWithNativeAPI(
          app,
          printerName,
          content,
          options.paperWidth || '80mm',
          // widthMm/heightMm activan el modo etiqueta (tamaño de página exacto).
          // Sólo los pasa la impresión de etiquetas; los recibos no, y quedan igual.
          // fullPage activa el modo hoja completa (A4) de la impresora normal/digital.
          { debugPdf: options.debugPdf === true, widthMm: options.widthMm, heightMm: options.heightMm, fullPage: options.fullPage === true }
        );
      } else if (method === 'escpos') {
        result = await printerMethods.printWithESCPOS(
          app,
          printerName,
          content,
          options.usbPort || 'USB003'
        );
      } else if (method === 'direct') {
        try {
          result = await printWithDirect(app, printerName, content);
        } catch (directErr) {
          return { success: false, error: `Direct method failed: ${directErr.message}` };
        }
      } else if (method === 'tspl') {
        const labelCfg = normalizeLabelPrinter(readSettings(app).labelPrinter);
        const targetPrinter = String(printerName || labelCfg.printerName || '').trim();
        if (!targetPrinter) {
          return { success: false, error: 'Impresora de etiquetas no configurada.' };
        }
        const payload =
          options && options.payload && typeof options.payload === 'object'
            ? options.payload
            : content && typeof content === 'object'
              ? (content.format === 'tspl' && content.payload ? content.payload : content)
              : buildSampleDispatchLabelPayload();
        const variant = (options && options.variant) || labelCfg.variant || 'oficial';
        result = await printTsplDispatchLabel(app, payload, { printerName: targetPrinter, variant });
      } else {
        return {
          success: false,
          error: `Unknown test method: ${method}`
        };
      }
      
      return result;
    } catch (error) {
      console.error('❌ [TEST] Error:', error);
      return { success: false, error: error.message };
    }
  });
  
  console.log('✅ [PRINTER] Handlers registered');
}

module.exports = {
  registerPrinterHandlers,
  printWithConfiguredPrinter,
  printTsplDispatchLabel,
  buildSampleDispatchLabelPayload,
};
