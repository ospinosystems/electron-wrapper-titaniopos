/**
 * TitanioPOS - Printer IPC Handlers
 * 
 * This module provides IPC handlers for printer configuration and printing.
 * It integrates the printer configuration and printing methods modules.
 */

const { ipcMain } = require('electron');
const printerConfig = require('./printer-config');
const printerMethods = require('./printer-methods');

/**
 * Register all printer-related IPC handlers
 * @param {Electron.App} app - Electron app instance
 * @param {Electron.BrowserWindow} mainWindow - Main window instance
 */
function registerPrinterHandlers(app, mainWindow) {
  
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
      // Load configuration
      const config = printerConfig.loadConfig();
      
      if (!config.printerName) {
        return { 
          success: false, 
          error: 'Printer not configured. Please configure printer in settings.' 
        };
      }
      
      console.log(`🖨️ [PRINT] Using method: ${config.method}`);
      
      // Use configured method
      let result;
      if (config.method === 'native') {
        // Native API expects HTML content
        result = await printerMethods.printWithNativeAPI(
          app,
          config.printerName,
          content,
          config.paperWidth
        );
      } else if (config.method === 'escpos') {
        // ESC/POS expects plain text content
        result = await printerMethods.printWithESCPOS(
          app,
          config.printerName,
          content,
          config.usbPort
        );
      } else {
        return { 
          success: false, 
          error: `Unknown print method: ${config.method}` 
        };
      }
      
      return result;
    } catch (error) {
      console.error('❌ [PRINT] Error:', error);
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
          options.paperWidth || '80mm'
        );
      } else if (method === 'escpos') {
        result = await printerMethods.printWithESCPOS(
          app,
          printerName,
          content,
          options.usbPort || 'USB003'
        );
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
  registerPrinterHandlers
};
