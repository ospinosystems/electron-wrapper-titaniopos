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

  /**
   * Notificar a Electron sobre el estado de los modales
   * @param {boolean} isOpen - true si hay un modal abierto, false si está cerrado
   */
  barcodeScannerSetModalState: (isOpen) => ipcRenderer.invoke('barcode-scanner-set-modal-state', isOpen),

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
    ipcRenderer.invoke('printer-test', method, printerName, content, options),

  // ==================== FISCAL MACHINE (HKA) ====================
  
  /**
   * Get fiscal machine configuration
   * @returns {Promise<{success: boolean, config: object}>}
   */
  fiscalConfigGet: () => ipcRenderer.invoke('fiscal-config-get'),
  
  /**
   * Save fiscal machine configuration
   * @param {object} config - Fiscal configuration
   * @returns {Promise<{success: boolean, config?: object, error?: string}>}
   */
  fiscalConfigSave: (config) => ipcRenderer.invoke('fiscal-config-save', config),
  
  /**
   * Check connection with fiscal server
   * @param {string} serverUrl - Optional server URL (uses config if not provided)
   * @returns {Promise<{success: boolean, connected: boolean, error?: string}>}
   */
  fiscalCheckConnection: (serverUrl) => ipcRenderer.invoke('fiscal-check-connection', serverUrl),
  
  /**
   * Send invoice to fiscal machine
   * @param {object} invoiceData - Invoice data with products
   * @returns {Promise<{success: boolean, job_id?: string, error?: string}>}
   */
  fiscalSendInvoice: (invoiceData) => ipcRenderer.invoke('fiscal-send-invoice', invoiceData),
  
  /**
   * Check status of a fiscal job
   * @param {string} jobId - Job ID to check
   * @returns {Promise<{success: boolean, estado?: string, error?: string}>}
   */
  fiscalCheckJobStatus: (jobId) => ipcRenderer.invoke('fiscal-check-job-status', jobId),
  
  /**
   * Get pending fiscal responses for sync
   * @returns {Promise<{success: boolean, responses: array}>}
   */
  fiscalGetPendingResponses: () => ipcRenderer.invoke('fiscal-get-pending-responses'),
  
  /**
   * Mark a fiscal response as synced to backend
   * @param {string} responseId - Response ID to mark
   * @returns {Promise<{success: boolean}>}
   */
  fiscalMarkSynced: (responseId) => ipcRenderer.invoke('fiscal-mark-synced', responseId),
  
  /**
   * Mark a fiscal response sync as failed
   * @param {string} responseId - Response ID
   * @param {string} errorMessage - Error message
   * @returns {Promise<{success: boolean}>}
   */
  fiscalMarkSyncError: (responseId, errorMessage) => 
    ipcRenderer.invoke('fiscal-mark-sync-error', responseId, errorMessage),
  
  /**
   * Get all fiscal responses
   * @returns {Promise<{success: boolean, responses: array}>}
   */
  fiscalGetAllResponses: () => ipcRenderer.invoke('fiscal-get-all-responses'),
  
  /**
   * Cleanup old synced responses (older than 7 days)
   * @returns {Promise<{success: boolean, removed: number}>}
   */
  fiscalCleanupOldResponses: () => ipcRenderer.invoke('fiscal-cleanup-old-responses'),
  
  /**
   * Send X Report to fiscal machine
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  fiscalSendReportX: () => ipcRenderer.invoke('fiscal-send-report-x'),
  
  /**
   * Send Z Report to fiscal machine
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  fiscalSendReportZ: () => ipcRenderer.invoke('fiscal-send-report-z'),
  
  /**
   * Configure COM port for fiscal machine
   * @param {string} comPort - COM port (e.g., 'COM1')
   * @returns {Promise<{success: boolean, comPort?: string, error?: string}>}
   */
  fiscalSetPort: (comPort) => ipcRenderer.invoke('fiscal-set-port', comPort),
  
  /**
   * Test connection with fiscal printer (not just server)
   * @returns {Promise<{success: boolean, printer_connected: boolean, retorno_txt?: string, error?: string}>}
   */
  fiscalTestPrinter: () => ipcRenderer.invoke('fiscal-test-printer'),
  
  /**
   * Get server fiscal configuration (from Python server)
   * @returns {Promise<{success: boolean, puerto_com?: string, ruta_programa?: string, error?: string}>}
   */
  fiscalGetServerConfig: () => ipcRenderer.invoke('fiscal-get-server-config'),

  // ==================== FISCAL SERVER MANAGEMENT ====================
  
  /**
   * Get fiscal server status
   * @returns {Promise<{success: boolean, running: boolean, healthy: boolean, port: number}>}
   */
  fiscalServerStatus: () => ipcRenderer.invoke('fiscal-server-status'),
  
  /**
   * Start fiscal server
   * @param {object} options - Options (port, intfhkaPath)
   * @returns {Promise<{success: boolean, port?: number, error?: string}>}
   */
  fiscalServerStart: (options = {}) => ipcRenderer.invoke('fiscal-server-start', options),
  
  /**
   * Stop fiscal server
   * @returns {Promise<{success: boolean}>}
   */
  fiscalServerStop: () => ipcRenderer.invoke('fiscal-server-stop'),
  
  /**
   * Restart fiscal server
   * @param {object} options - Options (port, intfhkaPath)
   * @returns {Promise<{success: boolean, port?: number, error?: string}>}
   */
  fiscalServerRestart: (options = {}) => ipcRenderer.invoke('fiscal-server-restart', options),
  
  /**
   * Check if Python is installed
   * @returns {Promise<{success: boolean, installed: boolean, command?: string}>}
   */
  fiscalCheckPython: () => ipcRenderer.invoke('fiscal-check-python')
});
