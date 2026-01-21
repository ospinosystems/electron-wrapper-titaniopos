const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura al renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Versiones de la app y runtimes
  getVersions: () => ipcRenderer.invoke('app-versions'),

  /**
   * Impresión silenciosa con HTML
   * @param {string} html - Contenido HTML a imprimir
   * @param {object} options - Opciones de impresión
   * @param {string} options.pageWidth - Ancho del papel: '58mm' o '80mm' (default: '80mm')
   * @param {string} options.printerName - Nombre de la impresora (opcional, usa default si no se especifica)
   */
  silentPrint: (html, options = {}) => ipcRenderer.invoke('silent-print', html, options),
  
  // Obtener lista de impresoras disponibles
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  
  /**
   * Imprimir a impresora específica con HTML
   * @param {string} printerName - Nombre de la impresora
   * @param {string} html - Contenido HTML a imprimir
   * @param {object} options - Opciones de impresión
   */
  printToPrinter: (printerName, html, options = {}) => 
    ipcRenderer.invoke('print-to-printer', printerName, html, options),
  
  // Verificar si estamos en Electron
  isElectron: true,

  // ==================== BACKUP DE ÓRDENES ====================
  
  /**
   * Guardar una orden individual en backup
   * @param {object} order - Objeto de la orden con al menos un campo 'id'
   */
  backupSaveOrder: (order) => ipcRenderer.invoke('backup-save-order', order),
  
  /**
   * Sincronizar todas las órdenes al backup (reemplaza el archivo completo)
   * @param {array} orders - Array de todas las órdenes
   */
  backupSaveAllOrders: (orders) => ipcRenderer.invoke('backup-save-all-orders', orders),
  
  /**
   * Obtener todas las órdenes del backup
   * @returns {Promise<{success: boolean, orders: array, lastSync: string}>}
   */
  backupGetAllOrders: () => ipcRenderer.invoke('backup-get-all-orders'),
  
  /**
   * Obtener la ruta del directorio de backups
   * @returns {Promise<{path: string}>}
   */
  backupGetPath: () => ipcRenderer.invoke('backup-get-path'),
  
  /**
   * Eliminar una orden del backup
   * @param {string|number} orderId - ID de la orden a eliminar
   */
  backupDeleteOrder: (orderId) => ipcRenderer.invoke('backup-delete-order', orderId),

  // ==================== PISTOLA DE CÓDIGOS DE BARRAS ====================
  
  /**
   * Escuchar eventos de códigos de barras escaneados
   * @param {function} callback - Función que recibe el código escaneado
   * @returns {function} Función para remover el listener
   */
  onBarcodeScanned: (callback) => {
    const listener = (event, barcode) => callback(barcode);
    ipcRenderer.on('barcode-scanned', listener);
    return () => ipcRenderer.removeListener('barcode-scanned', listener);
  },

  /**
   * Habilitar/deshabilitar detección de pistola de barras
   * @param {boolean} enabled - true para habilitar, false para deshabilitar
   */
  barcodeScannerEnable: (enabled) => ipcRenderer.invoke('barcode-scanner-enable', enabled),

  // ==================== PRINTER CONFIGURATION ====================
  
  /**
   * Get current printer configuration
   * @returns {Promise<{success: boolean, config: object}>}
   */
  printerConfigGet: () => ipcRenderer.invoke('printer-config-get'),
  
  /**
   * Save printer configuration
   * @param {object} config - Printer configuration
   * @returns {Promise<{success: boolean, config?: object, error?: string}>}
   */
  printerConfigSave: (config) => ipcRenderer.invoke('printer-config-save', config),
  
  /**
   * Get list of available printers
   * @returns {Promise<{success: boolean, printers: array}>}
   */
  printerList: () => ipcRenderer.invoke('printer-list'),
  
  /**
   * Print using configured printer and method
   * @param {string} content - Content to print (HTML for native, text for ESC/POS)
   * @param {object} options - Additional options
   * @returns {Promise<{success: boolean, method?: string, error?: string}>}
   */
  printerPrint: (content, options = {}) => ipcRenderer.invoke('printer-print', content, options),
  
  /**
   * Test print with specific method
   * @param {string} method - Method to test ('native' or 'escpos')
   * @param {string} printerName - Printer name
   * @param {string} content - Test content
   * @param {object} options - Additional options (paperWidth, usbPort, etc.)
   * @returns {Promise<{success: boolean, method?: string, error?: string}>}
   */
  printerTest: (method, printerName, content, options = {}) => 
    ipcRenderer.invoke('printer-test', method, printerName, content, options)
});
