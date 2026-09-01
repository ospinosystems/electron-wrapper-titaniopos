/**
 * TitanioPOS - Printer IPC Handlers
 * 
 * This module provides IPC handlers for printer configuration and printing.
 * It integrates the printer configuration and printing methods modules.
 */

const { ipcMain } = require('electron');
const printerConfig = require('./printer-config');
const printerMethods = require('./printer-methods');
const { printWithDirect, ensureHelper } = require('./printer-direct');
const { readSettings, writeSettings, normalizeLabelPrinter } = require('./titaniopos-settings-file');

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
    result = await printerMethods.printWithNativeAPI(
      app,
      config.printerName,
      content,
      config.paperWidth,
      { debugPdf: config.debugPdf === true }
    );
  } else if (useDirect) {
    try {
      result = await printWithDirect(app, config.printerName, content);
    } catch (directErr) {
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
   * Imprime una ETIQUETA (HTML) ruteando como printer-print: si esta caja usa
   * la impresora de etiquetas de otra (modo receive + useRemoteLabel), el
   * sticker viaja por HTTP a la anfitriona; si no, se imprime con la impresora
   * de etiquetas guardada en el settings (espejo de la config del front).
   */
  ipcMain.handle('printer-print-label', async (event, content) => {
    try {
      const printShare = require('./print-share');
      const remote = printShare.getRemoteLabelTarget(app);
      if (remote) {
        console.log(`🏷️ [PRINT] Etiqueta a caja anfitriona ${remote.hostIp}:${remote.hostPort}`);
        return await printShare.sendRemoteLabelPrint(remote, content);
      }

      const labelCfg = readSettings(app).labelPrinter || {};
      if (!labelCfg.printerName) {
        return { success: false, error: 'Impresora de etiquetas no configurada.' };
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
          { debugPdf: options.debugPdf === true, widthMm: options.widthMm, heightMm: options.heightMm }
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
  printWithConfiguredPrinter
};
