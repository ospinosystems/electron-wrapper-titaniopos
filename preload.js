const { contextBridge, ipcRenderer } = require('electron');

// Exponer API segura al renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Versiones de la app y runtimes
  getVersions: () => ipcRenderer.invoke('app-versions'),

  /** Guarda el tema (dark|light) para que el splash inicial lo use. */
  saveUiTheme: (theme) => ipcRenderer.invoke('ui:save-theme', theme),

  /** Fuente de la UI activa: 'web' (online) | 'local' (bundle offline). */
  getUiSource: () => ipcRenderer.invoke('ui:source'),

  /** (Re)crea el acceso directo de la app en el Escritorio. */
  createDesktopShortcut: () => ipcRenderer.invoke('app:create-desktop-shortcut'),

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

  // ==================== IMPRESIÓN EN RED (compartir impresoras) ====================

  /**
   * Config de impresión en red (sección printShare del settings unificado).
   * @returns {Promise<{success: boolean, config?: object, status?: object, error?: string}>}
   */
  printShareConfigGet: () => ipcRenderer.invoke('print-share-config-get'),

  /**
   * Guarda la config de impresión en red y aplica el estado del servidor
   * (arranca/detiene/reubica el puerto según el modo).
   * @param {object} partial - { mode, sharePort, hostIp, hostPort, useRemoteTicket, useRemoteFiscal }
   */
  printShareConfigSave: (partial) => ipcRenderer.invoke('print-share-config-save', partial),

  /** Estado del servidor de compartir: { mode, running, port, ips, error }. */
  printShareStatus: () => ipcRenderer.invoke('print-share-status'),

  /**
   * Prueba la conexión con una caja anfitriona: /health del servidor de
   * compartir + sondeo del servidor fiscal remoto.
   * @returns {Promise<{success: boolean, health?: object, fiscalReachable?: boolean, error?: string}>}
   */
  printShareCheckHost: (hostIp, hostPort) => ipcRenderer.invoke('print-share-check-host', hostIp, hostPort),

  // ==================== PINPAD ====================

  /**
   * Process pinpad transaction through local Electron proxy
   * @param {object} payload - Pinpad transaction payload
   * @returns {Promise<{success: boolean, status?: number, data?: object, error?: string}>}
   */
  pinpadTransaction: (payload) => ipcRenderer.invoke('pinpad-transaction', payload),

  /**
   * Smart POS (Megasoft VPOS RESTService) — compra/anulación de punto de venta
   * contra el servicio local en http://localhost:8085/vpos/...
   * @param {object} payload - { operation, amount(céntimos), document, numSeq, terminalVirtual, vposUrl }
   * @returns {Promise<{success: boolean, status?: number, data?: object, error?: string}>}
   */
  megaPosTransaction: (payload) => ipcRenderer.invoke('mega-pos-transaction', payload),

  /** Verifica que el VPOS RESTService está vivo. */
  megaPosPing: (payload = {}) => ipcRenderer.invoke('mega-pos-ping', payload),

  /** Reinicia / fuerza el arranque del servicio VPOS local. */
  megaPosRestart: () => ipcRenderer.invoke('mega-pos-restart'),

  /** Tareas de caja: imprimeUltimoVoucher | imprimeUltimoVoucherP | precierre | cierre | ultimoCierre. */
  megaPosTask: (action) => ipcRenderer.invoke('mega-pos-task', { action }),

  /** Fija [SeqNum] seqnum en el vposconf.ini y reinicia el servicio (soporte). */
  megaPosSetSeqnum: (value) => ipcRenderer.invoke('mega-pos-set-seqnum', value),

  /** Instala/desinstala la VPOS como admin (UAC): autoarranque de Windows. */
  megaPosInstallVpos: () => ipcRenderer.invoke('mega-pos-install-vpos'),
  megaPosUninstallVpos: () => ipcRenderer.invoke('mega-pos-uninstall-vpos'),

  /** Última transacción del VPOS desde sus archivos de control:
   *  { success, approved: <última APROBADA>, processed: <última PROCESADA> }
   *  con { codRespuesta, estado, numSeq, montoCents, fecha, hora, referencia,
   *  aprobacion, tarjeta, tipoTarjeta, voucherPath }. */
  megaPosLastTx: () => ipcRenderer.invoke('mega-pos-last-tx'),

  /** Vouchers registrados por el VPOS (más recientes primero): { success, dir,
   *  vouchers: [{ name, mtime, content }] }. */
  megaPosVouchers: (opts = {}) => ipcRenderer.invoke('mega-pos-vouchers', opts),

  /** Lee el texto del voucher/reporte que generó el VPOS (ruta de nombreVoucher). */
  megaPosReadVoucher: (filePath) => ipcRenderer.invoke('mega-pos-read-voucher', filePath),

  /** Instala el driver Verifone (P200) en silencio y elevado; deja el pinpad en COM9. */
  megaPosInstallDriver: () => ipcRenderer.invoke('mega-pos-install-driver'),

  /** Lista puertos COM y detecta si hay un Verifone conectado (prueba de conexión). */
  megaPosDetectPinpad: () => ipcRenderer.invoke('mega-pos-detect-pinpad'),

  /** Lee la config Smart POS (host/port Merchant Server + vtid/afiliación). */
  megaPosConfigGet: () => ipcRenderer.invoke('mega-pos-config-get'),

  /** Guarda la config Smart POS y reinicia el servicio para aplicarla. */
  megaPosConfigSave: (config) => ipcRenderer.invoke('mega-pos-config-save', config),

  /** Devuelve las secciones clave del vposconf.ini en uso (read-only, para verificar en la UI). */
  megaPosConfigDump: () => ipcRenderer.invoke('mega-pos-config-dump'),

  /** Lista de archivos de config relevantes (nombre + ruta). */
  megaPosConfigFiles: () => ipcRenderer.invoke('mega-pos-config-files'),

  /** Contenido completo de un archivo de config (key: settings|vposconf|vposuniversal). */
  megaPosReadConfigFile: (key) => ipcRenderer.invoke('mega-pos-read-config-file', key),

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
  fiscalMarkSyncError: (responseId, errorMessage, permanent = false) =>
    ipcRenderer.invoke('fiscal-mark-sync-error', responseId, errorMessage, permanent),

  /** Purga respuestas atascadas ('stuck' = synced/simuladas/fallos permanentes) o 'all'. */
  fiscalPurgeResponses: (mode = 'stuck') => ipcRenderer.invoke('fiscal-purge-responses', mode),

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

  /** Estado decodificado de la impresora (esperando/sin papel/memoria/transaccion). */
  fiscalGetStatus: () => ipcRenderer.invoke('fiscal-get-status'),

  /** Datos de la maquina fiscal (S1): RIF, serial registrado, contadores. */
  fiscalGetMachineData: () => ipcRenderer.invoke('fiscal-get-machine-data'),

  /** Lista las operaciones de prueba disponibles (Fijas del Fiscalizador). */
  fiscalListOperations: () => ipcRenderer.invoke('fiscal-list-operations'),

  /** Ejecuta una operacion de prueba (emite un documento fiscal real). */
  fiscalRunOperation: (name) => ipcRenderer.invoke('fiscal-run-operation', name),

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

  /** Busca actualizaciones de la app (diálogos nativos + banner). */
  updaterCheck: () => ipcRenderer.invoke('updater:check'),

  // ==================== HOT-SWAP DE LA VISTA (builds del frontend) ====================
  /** Lista las builds de la vista instaladas: { ok, active, next, builds:[n], keep }. */
  viewListBuilds: () => ipcRenderer.invoke('view:list-builds'),
  /** Switchea a una build instalada y relanza (opts.relaunch=false para solo programar). */
  viewSwitchBuild: (buildNumber, opts = {}) => ipcRenderer.invoke('view:switch-build', buildNumber, opts),
  /** Busca actualización de la vista AHORA contra prod: { ok, url, staged, buildNumber?, reason? }. */
  viewCheckNow: () => ipcRenderer.invoke('view:check-now'),
  /** Eventos del check automático de la vista: { type: 'downloading'|'progress'|'staged'|'error', ... }.
   *  Devuelve una función para desuscribirse. */
  onViewUpdate: (callback) => {
    const handler = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('view-update', handler);
    return () => ipcRenderer.removeListener('view-update', handler);
  },

  onUpdaterEvent: (callback) => {
    const handler = (_event, payload) => {
      try { callback(payload); } catch (err) { console.error('[updater event] handler threw:', err); }
    };
    ipcRenderer.on('updater:event', handler);
    return () => ipcRenderer.removeListener('updater:event', handler);
  },

  // ==================== SOPORTE REMOTO (RustDesk desatendido) ====================
  /** Estado: { available, enabled, hasPassword, running, id }. */
  remoteSupportStatus: () => ipcRenderer.invoke('remote-support:status'),
  /** Devuelve el ID de RustDesk de esta máquina. */
  remoteSupportGetId: () => ipcRenderer.invoke('remote-support:get-id'),
  /** Descarga rustdesk.exe del release oficial si no viene bundleado. */
  remoteSupportDownload: () => ipcRenderer.invoke('remote-support:download'),
  /** Activa el acceso desatendido con contraseña fija. Devuelve { id }. */
  remoteSupportEnable: (password) => ipcRenderer.invoke('remote-support:enable', password),
  /** Repara: desinstala limpio + reinstala el servicio en un solo UAC. */
  remoteSupportRepair: (password) => ipcRenderer.invoke('remote-support:repair', password),
  /** Desactiva el acceso desatendido y cierra RustDesk. */
  remoteSupportDisable: (password) => ipcRenderer.invoke('remote-support:disable', password),
  /** Abre la ventana de RustDesk manualmente. */
  remoteSupportOpen: () => ipcRenderer.invoke('remote-support:open'),
  /** Conecta desde esta máquina a un ID remoto (soporte). */
  remoteSupportConnect: (id) => ipcRenderer.invoke('remote-support:connect', id),

  // ==================== DRIVERS DE IMPRESORA ====================
  /** Estado: { available: { thermal, label, remove } }. */
  printerDriverStatus: () => ipcRenderer.invoke('printer-driver:status'),
  /** Lanza un instalador elevado. key: 'thermal' | 'label' | 'remove'. */
  printerDriverLaunch: (key) => ipcRenderer.invoke('printer-driver:launch', key)
});
