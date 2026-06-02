const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura al renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Versiones de la app y runtimes
  getVersions: () => ipcRenderer.invoke('app-versions'),

  /** Diagnóstico de GPU. Equivalente a chrome://gpu/ pero usable desde DevTools. */
  gpuStatus: () => ipcRenderer.invoke('gpu-status'),

  /** Recarga forzada sin caché (tras mostrar feedback en el renderer). */
  reloadIgnoringCache: () => ipcRenderer.invoke('reload-ignoring-cache'),

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
   * Obtener órdenes del backup (hoy por defecto, o rango inclusivo { from, to } en YYYY-MM-DD).
   * @param {{ from: string, to: string }|null|undefined} range - opcional; p. ej. apertura de jornada → hoy
   * @returns {Promise<{success: boolean, orders: array, lastSync: string}>}
   */
  backupGetAllOrders: (range) => ipcRenderer.invoke('backup-get-all-orders', range ?? null),
  
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

  /**
   * Admin: desbloquear inspector con contraseña (verificada en main).
   * @param {string} password
   */
  backupAdminUnlock: (password) => ipcRenderer.invoke('backup-admin-unlock', password),

  /** Admin: bloquear inspector (cerrar sesión del gate). */
  backupAdminLock: () => ipcRenderer.invoke('backup-admin-lock'),

  /** Admin: estado del gate (unlocked + configured + idleTimeoutMs + expiresAt). */
  backupAdminStatus: () => ipcRenderer.invoke('backup-admin-status'),

  /** Admin: extiende la sesión por actividad (mouse/teclado en el renderer). */
  backupAdminTouch: () => ipcRenderer.invoke('backup-admin-touch'),

  /**
   * Admin: listar archivos del directorio de backups (requiere unlock previo).
   * @returns {Promise<{success: boolean, dir: string, files: Array<{name,path,size,mtime}>}>}
   */
  backupAdminListFiles: () => ipcRenderer.invoke('backup-admin-list-files'),

  /**
   * Admin: leer un backup reportando su formato y validez de firma sin lanzar.
   * @param {string} filePath
   */
  backupAdminInspect: (filePath) => ipcRenderer.invoke('backup-admin-inspect', filePath),

  /**
   * Admin: re-firmar un payload editado a mano y sobrescribir el archivo en formato v2.
   * @param {string} filePath
   * @param {object} data - normalized backup data (lastSync, date, count, orders)
   */
  backupAdminResign: (filePath, data) => ipcRenderer.invoke('backup-admin-resign', filePath, data),

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

  // ==================== CAJA (sin fiscal) ====================

  /** @returns {Promise<{ success: boolean, config?: object, path?: string, error?: string }>} */
  cajaConfigGet: () => ipcRenderer.invoke('caja-config-get'),

  /** @param {object} partial - campos a fusionar en caja-config.json */
  cajaConfigSave: (partial) => ipcRenderer.invoke('caja-config-save', partial),

  /** @returns {Promise<{ success: boolean, config: { reduceAnimations: boolean }, error?: string }>} */
  appConfigGet: () => ipcRenderer.invoke('app-config-get'),

  /** @param {object} partial - campos a fusionar en ui config */
  appConfigSave: (partial) => ipcRenderer.invoke('app-config-save', partial),

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

  // ==================== PINPAD ====================

  /**
   * Process pinpad transaction through local Electron proxy
   * @param {object} payload - Pinpad transaction payload
   * @returns {Promise<{success: boolean, status?: number, data?: object, error?: string}>}
   */
  pinpadTransaction: (payload) => ipcRenderer.invoke('pinpad-transaction', payload),

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
   * Imprime factura de prueba: 1 producto exento, 1 Bs, efectivo.
   * GENERA DOCUMENTO FISCAL REAL con numero consecutivo.
   */
  fiscalTestPrint: () => ipcRenderer.invoke('fiscal-test-print'),

  /**
   * Imprime una factura de prueba CON codigo de barras para validar el formato
   * del comando 'Y' contra el HKA80 real. opts: { type, format }.
   * GENERA DOCUMENTO FISCAL REAL con numero consecutivo.
   */
  fiscalTestBarcode: (opts) => ipcRenderer.invoke('fiscal-test-barcode', opts),

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
  fiscalCheckPython: () => ipcRenderer.invoke('fiscal-check-python'),

  /**
   * Suscripción a eventos del auto-updater. Devuelve una función para desuscribirse.
   * Eventos:
   *   - 'start': { version }
   *   - 'progress': { percent, bytesPerSecond, transferred, total }
   *   - 'done': { version }   // descarga terminada, listo para reiniciar
   *   - 'error': { message }
   *   - 'cancelled': {}       // usuario eligió "Ahora no"
   */
  /** Reinicia la app e instala la actualización descargada. */
  updaterQuitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),

  /** Estado actual del updater (para reconstruir el banner tras un reload). */
  updaterGetState: () => ipcRenderer.invoke('updater:get-state'),

  onUpdaterEvent: (callback) => {
    const handler = (_event, payload) => {
      try { callback(payload); } catch (err) { console.error('[updater event] handler threw:', err); }
    };
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  }
});
