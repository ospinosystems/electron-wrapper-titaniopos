const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { registerPrinterHandlers } = require('./printer-handlers');
const { registerFiscalHandlers } = require('./fiscal-handlers');
const { registerPinpadHandlers } = require('./pinpad-handlers');
const {
  startFiscalServer,
  stopFiscalServer,
  getServerStatus,
  checkPythonInstalled
} = require('./fiscal-server-manager');

// Secret key para JWT - en producción debería estar en variable de entorno
const JWT_SECRET = process.env.TITANIOPOS_JWT_SECRET || 'titaniopos-secure-key-2024-change-in-production';

// Directorio para backups de órdenes - en Documentos para fácil acceso
const getBackupDir = () => {
  const documentsPath = app.getPath('documents');
  const backupDir = path.join(documentsPath, 'TitanioPOS-Backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
};

// Load .env from fiscal-server (portable config for port/path)
const loadFiscalEnv = () => {
  try {
    const envPath = path.join(__dirname, 'fiscal-server', '.env');
    if (!fs.existsSync(envPath)) return;
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    });
    console.log('[FISCAL SERVER] .env loaded from fiscal-server/.env');
  } catch (error) {
    console.warn('[FISCAL SERVER] Could not load .env:', error.message);
  }
};

// Codificar datos como JWT (sin expiración para mantener respaldo indefinidamente)
const encodeToJWT = (data) => {
  try {
    return jwt.sign({ data }, JWT_SECRET);
  } catch (error) {
    console.error('❌ [JWT] Error codificando:', error);
    throw error;
  }
};

// Decodificar JWT a datos
const decodeFromJWT = (token) => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.data;
  } catch (error) {
    console.error('❌ [JWT] Error decodificando:', error);
    throw error;
  }
};

// URL de tu PWA (cambiar en producción)
const APP_URL =
  process.env.TITANIOPOS_URL || "http://localhost:3001";
// process.env.TITANIOPOS_URL || "https://frontend.titanio-pos.com";

let mainWindow;

function setupNativeContextMenu(window) {
  if (!window) return;

  window.webContents.on('context-menu', (event, params) => {
    const { editFlags } = params || {};
    const hasSelection = Boolean(params && params.selectionText && params.selectionText.trim());
    const isEditable = Boolean(params && params.isEditable);

    const template = [];

    if (isEditable) {
      template.push(
        {
          label: 'Cortar',
          enabled: Boolean(editFlags && editFlags.canCut),
          click: () => window.webContents.cut(),
        },
        {
          label: 'Copiar',
          enabled: Boolean(editFlags && editFlags.canCopy),
          click: () => window.webContents.copy(),
        },
        {
          label: 'Pegar',
          enabled: Boolean(editFlags && editFlags.canPaste),
          click: () => window.webContents.paste(),
        },
        { type: 'separator' },
        {
          label: 'Seleccionar todo',
          enabled: Boolean(editFlags && editFlags.canSelectAll),
          click: () => window.webContents.selectAll(),
        }
      );
    } else if (hasSelection) {
      template.push(
        {
          label: 'Copiar',
          enabled: true,
          click: () => window.webContents.copy(),
        },
        { type: 'separator' },
        {
          label: 'Seleccionar todo',
          enabled: Boolean(editFlags && editFlags.canSelectAll),
          click: () => window.webContents.selectAll(),
        }
      );
    } else {
      template.push({
        label: 'Seleccionar todo',
        enabled: Boolean(editFlags && editFlags.canSelectAll),
        click: () => window.webContents.selectAll(),
      });
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    title: 'TitanioPOS'
  });

  mainWindow.loadURL(APP_URL);

  setupNativeContextMenu(mainWindow);

  // ==================== KEYBOARD / ZOOM CUSTOMIZATIONS ====================

  // Ctrl+Scroll → browser-like zoom
  mainWindow.webContents.on('zoom-changed', (event, zoomDirection) => {
    const current = mainWindow.webContents.getZoomFactor();
    if (zoomDirection === 'in') {
      mainWindow.webContents.setZoomFactor(Math.min(current + 0.1, 3.0));
    } else {
      mainWindow.webContents.setZoomFactor(Math.max(current - 0.1, 0.3));
    }
  });

  // Intercept specific key combos via before-input-event
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Ctrl+M → completely disabled
    if (input.control && !input.shift && !input.alt && !input.meta && input.key.toLowerCase() === 'm') {
      event.preventDefault();
      return;
    }

    // Ctrl+F5 → hard reload (clear cache)
    if (input.control && !input.shift && !input.alt && !input.meta && input.code === 'F5') {
      event.preventDefault();
      mainWindow.webContents.reloadIgnoringCache();
      return;
    }
  });

  mainWindow.webContents.openDevTools();

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window._originalPrint = window.print;
      window.print = function() {
        window.postMessage({ type: 'TITANIO_PRINT' }, '*');
      };
    `);
  });

  mainWindow.webContents.on('console-message', (event, level, message) => {
    if (message === 'TITANIO_SILENT_PRINT') {
      silentPrint();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: versiones (app y runtime)
ipcMain.handle('app-versions', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
}));

// Auto-actualización
function setupAutoUpdater() {
  autoUpdater.on('checking-for-update', () => {
    console.log('🔎 Buscando actualizaciones...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log(`⬇️ Actualización disponible: ${info.version}`);
  });

  autoUpdater.on('update-not-available', () => {
    console.log('✅ No hay actualizaciones disponibles.');
  });

  autoUpdater.on('error', (err) => {
    console.error('❌ Error en autoUpdater:', err);
  });

  autoUpdater.on('download-progress', (progressObj) => {
    console.log(
      `⬇️ Descargando: ${Math.round(progressObj.percent)}% ` +
      `(vel: ${Math.round(progressObj.bytesPerSecond / 1024)} KB/s)`
    );
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('📦 Actualización descargada, instalando...');
    autoUpdater.quitAndInstall();
  });

  autoUpdater.checkForUpdatesAndNotify();
}

// Impresión silenciosa
function silentPrint() {
  if (!mainWindow) return;

  mainWindow.webContents.print({
    silent: true,
    printBackground: true,
    margins: {
      marginType: 'none'
    }
  }, (success, failureReason) => {
    if (!success) {
      console.error('Print failed:', failureReason);
    } else {
      console.log('Print successful');
    }
  });
}

// Función para imprimir HTML en ventana oculta (método nativo simplificado)
function printHtmlInHiddenWindow(html, printerName = null, pageWidth = '80mm', options = {}) {
  return new Promise(async (resolve, reject) => {
    const printWindow = new BrowserWindow({
      show: false,
      width: pageWidth === '58mm' ? 220 : 302,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    const thermalCSS = `
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body {
          width: ${pageWidth};
          font-family: 'Courier New', monospace;
          font-size: 12px;
          line-height: 1.2;
          color: #000 !important;
          background: #fff !important;
        }
        .line { white-space: pre; line-height: 1.4; }
        .total { 
          font-weight: bold; 
          font-size: 14px; 
          border-top: 1px dashed #000; 
          padding-top: 4px; 
          margin-top: 4px; 
        }
        .uuid { 
          font-size: 8px; 
          text-align: center; 
          margin-top: 8px; 
          word-break: break-all; 
        }
        @media print {
          @page { margin: 0; }
          * {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
            color: #000 !important;
          }
        }
      </style>
    `;

    const fullHtml = html.includes('<html')
      ? html
      : `<!DOCTYPE html><html><head><meta charset="UTF-8">${thermalCSS}</head><body>${html}</body></html>`;

    printWindow.webContents.on('did-finish-load', async () => {
      console.log('🖨️ [MAIN] Contenido cargado');

      try {
        await new Promise(r => setTimeout(r, 800));

        let targetPrinter = printerName;
        if (!targetPrinter) {
          const printers = await printWindow.webContents.getPrintersAsync();
          const defaultPrinter = printers.find(p => p.isDefault);
          targetPrinter = defaultPrinter?.name;
        }
        console.log('🖨️ [MAIN] Impresora:', targetPrinter);

        // Generar PDF primero
        const backupDir = getBackupDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const pdfPath = path.join(backupDir, `print_${stamp}.pdf`);

        const pdfBuffer = await printWindow.webContents.printToPDF({
          printBackground: true,
          marginsType: 1,
          pageSize: { width: pageWidth === '58mm' ? 58000 : 80000, height: 297000 }
        });

        fs.writeFileSync(pdfPath, pdfBuffer);
        console.log('📄 [MAIN] PDF generado:', pdfPath);

        printWindow.close();

        // Usar PowerShell con Adobe Acrobat COM object para impresión silenciosa
        const { exec } = require('child_process');

        // Escapar comillas y backslashes para PowerShell
        const escapedPath = pdfPath.replace(/\\/g, '\\\\').replace(/"/g, '`"');
        const escapedPrinter = targetPrinter.replace(/"/g, '`"');

        // Script PowerShell que usa el objeto COM de Adobe/Acrobat para imprimir
        const psScript = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  
  # Intentar con Adobe Acrobat
  try {
    $acrobat = New-Object -ComObject AcroExch.PDDoc
    if ($acrobat.Open("${escapedPath}")) {
      $acrobat.PrintPages(0, $acrobat.GetNumPages() - 1, 2, 1, 0)
      Start-Sleep -Milliseconds 2000
      $acrobat.Close()
      [System.Runtime.Interopservices.Marshal]::ReleaseComObject($acrobat) | Out-Null
      Write-Output "Impreso con Adobe"
      exit 0
    }
  } catch {
    Write-Output "Adobe no disponible: $_"
  }
  
  # Fallback: usar shell para imprimir
  $shell = New-Object -ComObject Shell.Application
  $folder = $shell.NameSpace((Split-Path "${escapedPath}"))
  $file = $folder.ParseName((Split-Path "${escapedPath}" -Leaf))
  $file.InvokeVerb("print")
  Start-Sleep -Milliseconds 2000
  Write-Output "Impreso con Shell"
  exit 0
} catch {
  Write-Error $_.Exception.Message
  exit 1
}
`.trim();

        const printCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psScript.replace(/"/g, '\\"')}"`;

        console.log('🖨️ [MAIN] Ejecutando impresión con PowerShell');

        exec(printCommand, { timeout: 30000 }, (error, stdout, stderr) => {
          if (error) {
            console.error('❌ [MAIN] Error:', error.message);
            if (stderr) console.error('stderr:', stderr);
            resolve({ success: false, error: error.message, pdfPath });
          } else {
            console.log('✅ [MAIN] Impresión ejecutada');
            if (stdout) console.log('stdout:', stdout.trim());
            resolve({ success: true, printerName: targetPrinter, pdfPath });
          }

          // Limpiar PDF después de 10 segundos
          setTimeout(() => {
            try {
              if (fs.existsSync(pdfPath)) {
                fs.unlinkSync(pdfPath);
                console.log('🗑️ [MAIN] PDF eliminado');
              }
            } catch (e) {
              console.warn('⚠️ [MAIN] No se pudo eliminar PDF:', e?.message);
            }
          }, 10000);
        });
      } catch (error) {
        printWindow.close();
        reject(error);
      }
    });

    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fullHtml)}`);
  });
}

// IPC handler para impresión silenciosa con HTML
ipcMain.handle('silent-print', async (event, htmlContent, options = {}) => {
  console.log('🖨️ [MAIN] silent-print recibido');

  if (!htmlContent) {
    console.error('❌ [MAIN] HTML content vacío');
    return { success: false, error: 'HTML content vacío' };
  }

  try {
    const pageWidth = options.pageWidth || '80mm';
    const printerName = options.printerName || null;

    const result = await printHtmlInHiddenWindow(htmlContent, printerName, pageWidth, options);
    return result;
  } catch (error) {
    console.error('❌ [MAIN] Error completo:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// IPC handler para obtener lista de impresoras
ipcMain.handle('get-printers', async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers;
});

// IPC handler para imprimir a impresora específica con HTML
ipcMain.handle('print-to-printer', async (event, printerName, htmlContent, options = {}) => {
  console.log('🖨️ [MAIN] print-to-printer:', printerName);

  if (!htmlContent) {
    return { success: false, error: 'HTML content vacío' };
  }

  try {
    const pageWidth = options.pageWidth || '80mm';
    const result = await printHtmlInHiddenWindow(htmlContent, printerName, pageWidth, options);
    return result;
  } catch (error) {
    console.error('❌ [MAIN] Error:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

// ==================== BACKUP DE ÓRDENES ====================

// Guardar una orden en backup
ipcMain.handle('backup-save-order', async (event, order) => {
  try {
    const backupDir = getBackupDir();
    const fileName = `order_${order.id || Date.now()}.json`;
    const filePath = path.join(backupDir, fileName);

    fs.writeFileSync(filePath, JSON.stringify(order, null, 2), 'utf-8');
    console.log('💾 [BACKUP] Orden guardada:', fileName);

    return { success: true, path: filePath };
  } catch (error) {
    console.error('❌ [BACKUP] Error guardando orden:', error);
    return { success: false, error: error.message };
  }
});

// Helper para obtener fecha en formato YYYY-MM-DD
const getDateString = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

// Guardar múltiples órdenes - solo backup diario con JWT
ipcMain.handle('backup-save-all-orders', async (event, orders) => {
  try {
    const backupDir = getBackupDir();
    const dateStr = getDateString();

    // Solo archivo de backup diario
    const dailyBackupPath = path.join(backupDir, `backup_${dateStr}.json`);

    const backupData = {
      lastSync: new Date().toISOString(),
      date: dateStr,
      count: orders.length,
      orders: orders
    };

    // Codificar como JWT para seguridad
    const encodedData = encodeToJWT(backupData);

    // Guardar JWT en archivo
    fs.writeFileSync(dailyBackupPath, JSON.stringify({ token: encodedData }, null, 2), 'utf-8');

    console.log(`💾 [BACKUP] ${orders.length} órdenes guardadas (JWT) en backup_${dateStr}.json`);
    return { success: true, count: orders.length, date: dateStr };
  } catch (error) {
    console.error('❌ [BACKUP] Error en sync:', error);
    return { success: false, error: error.message };
  }
});

// Obtener órdenes del backup del día actual (para restauración)
ipcMain.handle('backup-get-all-orders', async () => {
  try {
    const backupDir = getBackupDir();
    const dateStr = getDateString();
    const todayBackupPath = path.join(backupDir, `backup_${dateStr}.json`);

    // Solo cargar órdenes del día actual
    if (!fs.existsSync(todayBackupPath)) {
      console.log(`📂 [BACKUP] No hay backup para hoy (${dateStr})`);
      return { success: true, orders: [], lastSync: null, date: dateStr };
    }

    const fileContent = JSON.parse(fs.readFileSync(todayBackupPath, 'utf-8'));

    let data;
    // Verificar si es formato JWT o JSON plano (backward compatibility)
    if (fileContent.token) {
      // Formato nuevo: JWT
      try {
        data = decodeFromJWT(fileContent.token);
        console.log(`📂 [BACKUP] ${data.orders?.length || 0} órdenes recuperadas (JWT) del día ${dateStr}`);
      } catch (jwtError) {
        console.error('❌ [BACKUP] Error decodificando JWT:', jwtError);
        return { success: false, error: 'Token JWT inválido o manipulado', errorCode: 'JWT_INVALID_SIGNATURE', orders: [] };
      }
    } else {
      // Formato antiguo: JSON plano (para compatibilidad)
      data = fileContent;
      console.log(`📂 [BACKUP] ${data.orders?.length || 0} órdenes recuperadas (JSON) del día ${dateStr}`);
    }

    return {
      success: true,
      orders: data.orders || [],
      lastSync: data.lastSync,
      count: data.count,
      date: dateStr
    };
  } catch (error) {
    console.error('❌ [BACKUP] Error leyendo backup:', error);
    return { success: false, error: error.message, orders: [] };
  }
});

// Obtener ruta del directorio de backups
ipcMain.handle('backup-get-path', async () => {
  return { path: getBackupDir() };
});

// Eliminar una orden del backup del día actual
ipcMain.handle('backup-delete-order', async (event, orderId) => {
  try {
    const backupDir = getBackupDir();
    const dateStr = getDateString();
    const todayBackupPath = path.join(backupDir, `backup_${dateStr}.json`);

    if (fs.existsSync(todayBackupPath)) {
      const data = JSON.parse(fs.readFileSync(todayBackupPath, 'utf-8'));
      data.orders = data.orders.filter(o => o.id !== orderId);
      data.count = data.orders.length;
      data.lastSync = new Date().toISOString();
      fs.writeFileSync(todayBackupPath, JSON.stringify(data, null, 2), 'utf-8');
    }

    // También eliminar archivo individual si existe
    const individualPath = path.join(backupDir, `order_${orderId}.json`);
    if (fs.existsSync(individualPath)) {
      fs.unlinkSync(individualPath);
    }

    console.log('🗑️ [BACKUP] Orden eliminada:', orderId);
    return { success: true };
  } catch (error) {
    console.error('❌ [BACKUP] Error eliminando:', error);
    return { success: false, error: error.message };
  }
});

// ==================== PRINTER DEBUG METHODS ====================

// Técnica 1: Native Electron Print API (Optimizado para Térmicas)
ipcMain.handle('printer-test-native', async (event, printerName, testContent) => {
  console.log(' [DEBUG] Técnica 1: Native Electron Print API');
  try {
    const printWindow = new BrowserWindow({
      show: false,
      width: 302,  // 80mm en píxeles (aprox)
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    // HTML optimizado para impresoras térmicas con todas las recomendaciones
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          /* Configuración crítica para térmicas */
          @page {
            size: 80mm 200mm;
            margin: 0mm;  /* CRÍTICO: Sin márgenes */
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: 'Courier New', monospace;
            font-size: 14px;
            width: 80mm;  /* CRÍTICO: Ancho exacto */
            margin: 0;
            padding: 5mm;
            background: white !important;
            color: #000000 !important;  /* CRÍTICO: Negro puro */
          }
          
          .header {
            text-align: center;
            font-weight: bold;
            font-size: 16px;
            margin-bottom: 5mm;
            color: #000000 !important;
          }
          
          .line {
            margin: 3mm 0;
            color: #000000 !important;
          }
          
          /* CRÍTICO: Forzar renderizado exacto de colores */
          @media print {
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color: #000000 !important;
            }
            
            body {
              width: 80mm;
              margin: 0;
              padding: 5mm;
              color: #000000 !important;
            }
          }
        </style>
      </head>
      <body>
        <div class="header">═══ TEST NATIVE ═══</div>
        <div class="line">${testContent || 'Test de impresión nativa'}</div>
        <div class="line">Fecha: ${new Date().toLocaleString()}</div>
        <div class="line">Método: Native API Optimizado</div>
        <div class="line">Impresora: ${printerName}</div>
        <div class="line">═════════════════</div>
      </body>
      </html>
    `;

    // Guardar HTML para inspección
    const backupDir = getBackupDir();
    const htmlPath = path.join(backupDir, `test_native_${Date.now()}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWindow.setTitle('TitanioPOS - Test Ticket');

    // Esperar más tiempo para asegurar renderizado completo
    await new Promise(r => setTimeout(r, 2000));

    // Configuración optimizada para térmicas
    const printOptions = {
      silent: true,
      deviceName: printerName,
      printBackground: true,
      color: false,  // CRÍTICO: Térmicas no usan color
      margins: {
        marginType: 'none'  // CRÍTICO: Sin márgenes
      },
      pageSize: {
        width: 80000,   // 80mm en micras
        height: 200000  // Altura suficiente para el ticket
      }
    };

    console.log(' Opciones de impresión:', JSON.stringify(printOptions, null, 2));

    // Intentar impresión directa con configuración optimizada
    return new Promise((resolve) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        console.log(success ? ' Impresión enviada' : ` Falló: ${failureReason}`);

        printWindow.close();

        // Limpiar archivo HTML después de un tiempo
        setTimeout(() => {
          try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath); } catch (e) { }
        }, 5000);

        resolve({
          success,
          method: 'Native Electron Print API (Optimizado)',
          htmlPath,
          error: success ? undefined : failureReason,
          config: 'Márgenes: none, Color: false, PageSize: 80x200mm'
        });
      });
    });
  } catch (error) {
    console.error(' [DEBUG] Native print error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 2: PDF Generation + System Print
ipcMain.handle('printer-test-pdf', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 2: PDF Generation');
  try {
    const printWindow = new BrowserWindow({
      show: false,
      width: 302,
      height: 600,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          * { margin: 0; padding: 0; }
          body { 
            width: 80mm; 
            font-family: 'Courier New', monospace; 
            font-size: 12px;
            padding: 5mm;
          }
          .header { font-weight: bold; text-align: center; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="header">TEST - PDF METHOD</div>
        <div>${testContent || 'Test de impresión PDF'}</div>
        <div>Fecha: ${new Date().toLocaleString()}</div>
        <div>Método: PDF Generation</div>
      </body>
      </html>
    `;

    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise(r => setTimeout(r, 500));

    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      marginsType: 1,
      pageSize: { width: 80000, height: 297000 }
    });

    const backupDir = getBackupDir();
    const pdfPath = path.join(backupDir, `test_${Date.now()}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    printWindow.close();

    const { exec } = require('child_process');
    const escapedPath = pdfPath.replace(/\\/g, '\\\\');
    const printCommand = `powershell -Command "Start-Process -FilePath '${escapedPath}' -Verb Print"`;

    exec(printCommand, (error) => {
      setTimeout(() => {
        try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch (e) { }
      }, 5000);
    });

    return { success: true, method: 'PDF Generation', pdfPath };
  } catch (error) {
    console.error('❌ [DEBUG] PDF print error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 3: node-thermal-printer Library
ipcMain.handle('printer-test-thermal', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 3: node-thermal-printer');

  const printerTypes = [
    { type: PrinterTypes.EPSON, name: 'EPSON' },
    { type: PrinterTypes.STAR, name: 'STAR' },
    { type: PrinterTypes.TANCA, name: 'TANCA' }
  ];

  let lastError = null;

  for (const printerType of printerTypes) {
    try {
      console.log(`🖨️ Intentando con tipo: ${printerType.name}`);

      let printer;
      try {
        printer = new ThermalPrinter({
          type: printerType.type,
          interface: `printer:${printerName}`,
          characterSet: 'PC858_EURO',
          removeSpecialCharacters: false,
          lineCharacter: '-',
          width: 48
        });
      } catch (e) {
        console.log('⚠️ Interface printer: falló, intentando sin interface');
        printer = new ThermalPrinter({
          type: printerType.type,
          characterSet: 'PC858_EURO',
          removeSpecialCharacters: false,
          lineCharacter: '-',
          width: 48
        });
      }

      printer.alignCenter();
      printer.bold(true);
      printer.println('=== TEST THERMAL ===');
      printer.bold(false);
      printer.alignLeft();
      printer.newLine();
      printer.println(testContent || 'Test termica');
      printer.println(`Fecha: ${new Date().toLocaleString()}`);
      printer.println(`Tipo: ${printerType.name}`);
      printer.newLine();
      printer.drawLine();
      printer.newLine();
      printer.cut();

      const buffer = await printer.execute();
      console.log(`✅ Thermal buffer generado: ${buffer.length} bytes`);

      // Intentar imprimir el buffer directamente
      const { exec } = require('child_process');
      const tempFile = path.join(app.getPath('temp'), `thermal_${Date.now()}.prn`);
      fs.writeFileSync(tempFile, buffer);

      await new Promise((resolve, reject) => {
        exec(`print /D:"${printerName}" "${tempFile}"`, (error) => {
          setTimeout(() => {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
          }, 2000);

          if (error) reject(error);
          else resolve();
        });
      });

      return {
        success: true,
        method: `node-thermal-printer (${printerType.name})`,
        bytes: buffer.length
      };
    } catch (error) {
      console.error(`❌ Error con ${printerType.name}:`, error.message);
      lastError = error;
      continue;
    }
  }

  return { success: false, error: lastError?.message || 'Todos los tipos fallaron' };
});

// Técnica 4: ESC/POS Raw Commands via Spooler
ipcMain.handle('printer-test-escpos', async (event, printerName, testContent, manualUsbPort) => {
  console.log('🖨️ [DEBUG] Técnica 4: ESC/POS Raw Commands');

  return new Promise(async (resolve) => {
    try {
      const { exec } = require('child_process');
      const backupDir = path.join(app.getPath('documents'), 'TitanioPOS-Backups');
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      const tempFile = path.join(backupDir, `escpos_${Date.now()}.prn`);

      // Generar comandos ESC/POS raw
      const ESC = '\x1B';
      const GS = '\x1D';
      let data = '';
      data += ESC + '@';                    // Inicializar impresora
      data += ESC + 'a' + '\x01';           // Centrar
      data += ESC + '!' + '\x10';           // Negrita
      data += '=== TEST ESC/POS ===\n';
      data += ESC + '!' + '\x00';           // Normal
      data += ESC + 'a' + '\x00';           // Izquierda
      data += '\n' + (testContent || 'Test ESC/POS Directo') + '\n';
      data += 'Fecha: ' + new Date().toLocaleString() + '\n';
      data += 'Impresora: ' + printerName + '\n';
      data += 'Metodo: ESC/POS Raw Spooler\n';
      data += '\n\n\n';
      data += GS + 'V' + '\x00';            // Cortar papel

      fs.writeFileSync(tempFile, data, 'binary');
      console.log('📄 Archivo ESC/POS generado:', tempFile);

      // Usar puerto USB manual o detectar automáticamente
      let usbPort = manualUsbPort;

      if (!usbPort) {
        const printers = await mainWindow.webContents.getPrintersAsync();
        const targetPrinter = printers.find(p => p.name === printerName);

        if (targetPrinter && targetPrinter.options && targetPrinter.options.portName) {
          usbPort = targetPrinter.options.portName;
        }
      }

      console.log(`📌 Puerto USB: ${usbPort || 'No detectado'}`);
      if (manualUsbPort) console.log(`   (Configurado manualmente: ${manualUsbPort})`);

      // Intentar múltiples métodos
      const methods = [];

      // Método 1: Windows Spooler API directo con RAW datatype (el más confiable para ESC/POS)
      // Crear script de PowerShell en archivo temporal
      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class RawPrinter {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool OpenPrinter([MarshalAs(UnmanagedType.LPStr)] string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);
    public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "ESC/POS Document";
        di.pDataType = "RAW";
        bool bSuccess = false;
        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            if (StartDocPrinter(hPrinter, 1, di)) {
                if (StartPagePrinter(hPrinter)) {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(pBytes.Length);
                    Marshal.Copy(pBytes, 0, pUnmanagedBytes, pBytes.Length);
                    int dwWritten;
                    bSuccess = WritePrinter(hPrinter, pUnmanagedBytes, pBytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return bSuccess;
    }
}
"@
$bytes = [System.IO.File]::ReadAllBytes('${tempFile.replace(/\\/g, '\\\\')}')
$result = [RawPrinter]::SendBytesToPrinter('${printerName}', $bytes)
if ($result) { Write-Host 'SUCCESS' } else { Write-Host 'FAILED'; exit 1 }
`;

      const psScriptFile = path.join(backupDir, `print_${Date.now()}.ps1`);
      fs.writeFileSync(psScriptFile, psScript, 'utf8');

      methods.push({
        cmd: `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`,
        name: 'WinSpool RAW API',
        cleanup: psScriptFile
      });

      // Método 2: print /D tradicional
      methods.push({
        cmd: `print /D:"${printerName}" "${tempFile}"`,
        name: 'print /D'
      });

      let lastError = null;
      for (const method of methods) {
        console.log(`🖨️ Intentando: ${method.name}`);
        console.log(`   Comando: ${method.cmd}`);

        const result = await new Promise((methodResolve) => {
          exec(method.cmd, (error, stdout, stderr) => {
            if (stdout) console.log(`   stdout: ${stdout}`);
            if (stderr) console.log(`   stderr: ${stderr}`);

            if (!error) {
              console.log(`✅ ${method.name} ejecutado sin errores`);
              methodResolve({ success: true, method: method.name, command: method.cmd });
            } else {
              console.log(`⚠️ ${method.name} falló:`, error.message);
              lastError = error;
              methodResolve({ success: false });
            }
          });
        });

        if (result.success) {
          setTimeout(() => {
            try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
            if (method.cleanup) {
              try { if (fs.existsSync(method.cleanup)) fs.unlinkSync(method.cleanup); } catch (e) { }
            }
          }, 3000);
          resolve({
            success: true,
            method: `ESC/POS ${result.method}`,
            file: tempFile,
            command: result.command,
            port: usbPort
          });
          return;
        }
      }

      // Limpiar archivos temporales si todos fallaron
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
        methods.forEach(m => {
          if (m.cleanup) {
            try { if (fs.existsSync(m.cleanup)) fs.unlinkSync(m.cleanup); } catch (e) { }
          }
        });
      }, 3000);

      resolve({
        success: false,
        error: lastError?.message || 'Todos los métodos fallaron',
        file: tempFile,
        port: usbPort,
        triedMethods: methods.length
      });
    } catch (error) {
      console.error('❌ [DEBUG] ESC/POS error:', error);
      resolve({ success: false, error: error.message });
    }
  });
});

// Técnica 5: Serial Port Direct Communication
ipcMain.handle('printer-test-serial', async (event, portName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 5: Serial Port Direct');

  if (!portName) {
    return { success: false, error: 'No se especificó puerto serial' };
  }

  const baudRates = [9600, 19200, 38400, 115200];

  for (const baudRate of baudRates) {
    try {
      console.log(`🖨️ Intentando ${portName} a ${baudRate} baud`);

      const result = await new Promise((resolve, reject) => {
        let port;

        try {
          port = new SerialPort({
            path: portName,
            baudRate: baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none'
          });
        } catch (e) {
          reject(e);
          return;
        }

        const timeout = setTimeout(() => {
          if (port && port.isOpen) port.close();
          reject(new Error('Timeout abriendo puerto'));
        }, 5000);

        port.on('open', () => {
          clearTimeout(timeout);
          console.log(`✅ Puerto ${portName} abierto a ${baudRate}`);

          const ESC = '\x1B';
          const GS = '\x1D';

          let data = '';
          data += ESC + '@';
          data += ESC + 'a' + '\x01';
          data += ESC + '!' + '\x10';
          data += '=== TEST SERIAL ===\n';
          data += ESC + '!' + '\x00';
          data += ESC + 'a' + '\x00';
          data += '\n';
          data += (testContent || 'Test Serial') + '\n';
          data += `Baud: ${baudRate}\n`;
          data += `Fecha: ${new Date().toLocaleString()}\n`;
          data += '\n\n\n';
          data += GS + 'V' + '\x00';

          port.write(data, (error) => {
            setTimeout(() => {
              if (port && port.isOpen) port.close();
            }, 1000);

            if (error) {
              reject(error);
            } else {
              resolve({ success: true, method: `Serial ${baudRate} baud`, port: portName });
            }
          });
        });

        port.on('error', (error) => {
          clearTimeout(timeout);
          console.error(`❌ Error en puerto:`, error.message);
          reject(error);
        });
      });

      if (result.success) {
        return result;
      }
    } catch (error) {
      console.error(`❌ Falló con ${baudRate}:`, error.message);
      continue;
    }
  }

  return { success: false, error: 'Todos los baud rates fallaron' };
});

// Técnica 6: Windows Printing via PowerShell RAW
ipcMain.handle('printer-test-powershell-raw', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 6: PowerShell RAW Printing');
  try {
    const { exec } = require('child_process');

    // Crear archivo temporal con comandos ESC/POS
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `print_${Date.now()}.txt`);

    const ESC = '\x1B';
    const content = `${ESC}@${ESC}a\x01${ESC}E\x01TEST - POWERSHELL RAW${ESC}E\x00${ESC}a\x00\n\n${testContent || 'Test PowerShell RAW'}\nFecha: ${new Date().toLocaleString()}\nMétodo: PowerShell RAW\n\n\n`;

    fs.writeFileSync(tempFile, content);

    const psScript = `
      $printerName = "${printerName.replace(/"/g, '`"')}"
      $filePath = "${tempFile.replace(/\\/g, '\\\\')}"
      $content = [System.IO.File]::ReadAllBytes($filePath)
      $printer = New-Object System.Drawing.Printing.PrintDocument
      $printer.PrinterSettings.PrinterName = $printerName
      $stream = New-Object System.IO.MemoryStream(,$content)
      $printer.PrintPage = {
        param($sender, $ev)
        $ev.Graphics.DrawString([System.Text.Encoding]::ASCII.GetString($content), (New-Object System.Drawing.Font("Courier New", 10)), [System.Drawing.Brushes]::Black, 0, 0)
      }
      $printer.Print()
    `;

    const command = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;

    exec(command, (error, stdout, stderr) => {
      setTimeout(() => {
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
      }, 2000);
    });

    return { success: true, method: 'PowerShell RAW Printing' };
  } catch (error) {
    console.error('❌ [DEBUG] PowerShell RAW error:', error);
    return { success: false, error: error.message };
  }
});

// Técnica 7: Direct RAW printing to Windows Spooler
ipcMain.handle('printer-test-raw-spooler', async (event, printerName, testContent) => {
  console.log('🖨️ [DEBUG] Técnica 7: RAW Spooler');
  try {
    if (!printerName) {
      return { success: false, error: 'No se especificó impresora' };
    }
    const { exec } = require('child_process');

    // Crear archivo temporal con comandos ESC/POS
    const tempDir = app.getPath('temp');
    const tempFile = path.join(tempDir, `raw_${Date.now()}.txt`);

    // Comandos ESC/POS puros
    const ESC = '\x1B';
    const GS = '\x1D';

    let rawData = '';
    rawData += ESC + '@'; // Inicializar
    rawData += ESC + 'a' + '\x01'; // Centrar
    rawData += ESC + '!' + '\x10'; // Doble altura
    rawData += '=== TEST RAW ===\n';
    rawData += ESC + '!' + '\x00'; // Normal
    rawData += ESC + 'a' + '\x00'; // Izquierda
    rawData += '\n';
    rawData += (testContent || 'Test RAW Spooler') + '\n';
    rawData += 'Fecha: ' + new Date().toLocaleString() + '\n';
    rawData += 'Metodo: RAW Spooler\n';
    rawData += '=================\n';
    rawData += '\n\n\n';
    rawData += GS + 'V' + '\x00'; // Cortar

    fs.writeFileSync(tempFile, rawData, 'binary');

    // Intentar múltiples métodos
    // Nombre de recurso compartido: usa el nombre que el usuario define (idealmente sin espacios)
    const escapedPrinter = printerName.replace(/"/g, '""');
    const hostname = os.hostname();
    const shareLocalhost = `\\\\\\\\localhost\\\\${escapedPrinter}`;
    const shareLoopback = `\\\\\\\\127.0.0.1\\\\${escapedPrinter}`;
    const shareHost = `\\\\\\\\${hostname}\\\\${escapedPrinter}`;

    const psRawDirect = `
powershell -Command "$printer='${escapedPrinter}';$path='${tempFile.replace(/\\/g, '\\\\')}';$bytes=[System.IO.File]::ReadAllBytes($path);
Add-Type -Namespace Printing -Name RawPrint -MemberDefinition @'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"OpenPrinterA\\", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"ClosePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"StartDocPrinterA\\", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, IntPtr di);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"StartPagePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"EndPagePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"EndDocPrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport(\\"winspool.drv\\", EntryPoint=\\"WritePrinter\\", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] data, int buf, out int pcWritten);
  public static bool SendBytesToPrinter(string szPrinterName, byte[] data) {
    IntPtr hPrinter;
    if (!OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) return false;
    if (!StartDocPrinter(hPrinter, 1, IntPtr.Zero)) { ClosePrinter(hPrinter); return false; }
    if (!StartPagePrinter(hPrinter)) { EndDocPrinter(hPrinter); ClosePrinter(hPrinter); return false; }
    int dwWritten = 0;
    bool ok = WritePrinter(hPrinter, data, data.Length, out dwWritten);
    EndPagePrinter(hPrinter);
    EndDocPrinter(hPrinter);
    ClosePrinter(hPrinter);
    return ok;
  }
}
'@;
$res=[Printing.RawPrinterHelper]::SendBytesToPrinter($printer,$bytes);
if($res){'OK'}else{'FAIL'}"`;

    const methods = [
      // Método 1: WinSpool RAW directo (sin compartir)
      psRawDirect,
      // Método 2: copy /B a UNC \\localhost\share
      `copy /B "${tempFile}" "${shareLocalhost}"`,
      // Método 3: copy /B a UNC \\127.0.0.1\share
      `copy /B "${tempFile}" "${shareLoopback}"`,
      // Método 4: copy /B a UNC \\HOSTNAME\share
      `copy /B "${tempFile}" "${shareHost}"`,
      // Método 5: print /D con nombre de dispositivo
      `print /D:"${escapedPrinter}" "${tempFile}"`,
      // Método 6: PowerShell Out-Printer
      `powershell -Command "Get-Content -Path '${tempFile}' -Raw | Out-Printer -Name '${escapedPrinter}'"`
    ];

    for (let i = 0; i < methods.length; i++) {
      const command = methods[i];
      console.log(`🖨️ Intentando método ${i + 1}: ${command.substring(0, 80)}...`);

      const result = await new Promise((resolve) => {
        exec(command, { timeout: 10000 }, (error, stdout, stderr) => {
          const out = stdout?.toString() || '';
          const err = stderr?.toString() || '';
          const deviceError = out.includes('Unable to initialize device') || err.includes('Unable to initialize device');
          const copySuccess = out.includes('1 file(s) copied') || out.toLowerCase().includes('copied') || err.toLowerCase().includes('copied') || out.trim() === 'OK';

          if (error || deviceError) {
            const msg = deviceError ? 'Unable to initialize device' : error?.message;
            console.error(`❌ Método ${i + 1} falló:`, msg);
            resolve({ success: false, error: msg, stdout: out, stderr: err, command });
          } else {
            const ok = copySuccess || !error;
            if (!ok) {
              console.error(`❌ Método ${i + 1} sin confirmación de copia`);
              resolve({ success: false, error: 'Sin confirmación de copia', stdout: out, stderr: err, command });
            } else {
              console.log(`✅ Método ${i + 1} ejecutado`);
              resolve({ success: true, method: `RAW Spooler (Método ${i + 1})`, stdout: out, stderr: err, command });
            }
          }
        });
      });

      if (result.success) {
        setTimeout(() => {
          try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
        }, 2000);
        return result;
      }
    }

    setTimeout(() => {
      try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) { }
    }, 2000);

    return { success: false, error: 'Todos los métodos RAW fallaron' };
  } catch (error) {
    console.error('❌ [DEBUG] RAW Spooler error:', error);
    return { success: false, error: error.message };
  }
});

// Obtener puertos seriales disponibles
ipcMain.handle('printer-get-serial-ports', async () => {
  try {
    const ports = await SerialPort.list();
    console.log('📡 Serial ports found:', ports.length);
    return { success: true, ports };
  } catch (error) {
    console.error('❌ Error listing serial ports:', error);
    return { success: false, error: error.message, ports: [] };
  }
});

app.whenReady().then(() => {
  // Load fiscal env before starting anything related to fiscal server
  loadFiscalEnv();

  const backupPath = getBackupDir();
  console.log('📁 [BACKUP] Backup directory:', backupPath);
  console.log('📱 [BARCODE] Barcode scanner system initialized');

  createWindow();
  setupAutoUpdater();

  // Register printer handlers immediately after window is created
  registerPrinterHandlers(app, mainWindow);
  console.log('🖨️ [PRINTER] Printer system initialized');

  // Register fiscal handlers for HKA fiscal machine
  registerFiscalHandlers(app);
  console.log('🧾 [FISCAL] Fiscal machine system initialized');

  // Register pinpad handlers for local LAN proxy
  registerPinpadHandlers();
  console.log('💳 [PINPAD] Local proxy initialized');

  // Start fiscal server automatically (async, non-blocking)
  (async () => {
    try {
      const fiscalPort = process.env.FISCAL_SERVER_PORT ? Number(process.env.FISCAL_SERVER_PORT) : 3000;
      const intfhkaPath = process.env.INTFHKA_PATH || null;
      const pythonCheck = await checkPythonInstalled();
      if (pythonCheck.installed) {
        console.log('🐍 [FISCAL SERVER] Python found:', pythonCheck.command);
        const result = await startFiscalServer({ port: fiscalPort, intfhkaPath });
        if (result.success) {
          console.log('✅ [FISCAL SERVER] Server started on port', result.port);
        } else {
          console.warn('⚠️ [FISCAL SERVER] Failed to start:', result.error);
        }
      } else {
        console.warn('⚠️ [FISCAL SERVER] Python not installed - fiscal server disabled');
      }
    } catch (error) {
      console.error('❌ [FISCAL SERVER] Error starting:', error);
    }
  })();
});

app.on('window-all-closed', () => {
  // Stop fiscal server before quitting
  stopFiscalServer();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // Ensure fiscal server is stopped
  stopFiscalServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


