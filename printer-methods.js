/**
 * TitanioPOS - Thermal Printer Methods Module
 * 
 * This module implements two reliable printing methods for thermal printers:
 * 
 * 1. NATIVE METHOD (Electron Print API):
 *    - Uses Chromium's print engine with thermal-optimized settings
 *    - Zero margins, exact color rendering, proper page sizing
 *    - Works well for HTML-based receipts
 *    - WARNING: Heavy on CPU. Use only when ESC/POS is not available.
 * 
 * 2. ESC/POS RAW METHOD (Windows Spooler API):
 *    - Sends raw ESC/POS commands directly to printer
 *    - Uses Windows winspool.drv API with RAW datatype
 *    - Most reliable for thermal printers, bypasses driver issues
 *    - RECOMMENDED for production and low-end CPUs (Celeron)
 */

const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/**
 * Get backup directory for temporary files
 * @param {Electron.App} app - Electron app instance
 * @returns {string} Backup directory path
 */
function getBackupDir(app) {
  const documentsPath = app.getPath('documents');
  const backupDir = path.join(documentsPath, 'TitanioPOS-Backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}

/**
 * METHOD 1: Native Electron Print API (Optimized for Thermal Printers)
 * 
 * ⚠️ SLOW on low-end CPUs because it renders HTML + generates PDF debug.
 * Use ESC/POS whenever possible.
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {string} printerName - Windows printer name
 * @param {string} htmlContent - HTML content to print
 * @param {string} paperWidth - Paper width ('58mm' or '80mm')
 * @param {Object} options - Options: { debugPdf: boolean }
 * @returns {Promise<Object>} Result with success status
 */
async function printWithNativeAPI(app, printerName, htmlContent, paperWidth = '80mm', options = {}) {
  console.log('🖨️ [NATIVE] Starting print job');
  const debugPdf = options.debugPdf === true;

  // MODO ETIQUETA — sólo se activa si el frontend pasa dimensiones explícitas
  // (widthMm/heightMm). La impresión normal de recibos NO las pasa, así que su
  // ruta queda EXACTAMENTE igual que antes (página 80mm × 200mm, Courier, padding
  // 5mm). No tocar esa rama para no afectar la facturación.
  const labelW = Number(options.widthMm);
  const labelH = Number(options.heightMm);
  const labelMode = labelW > 0 && labelH > 0;
  if (labelMode) console.log(`🏷️ [NATIVE] Label mode ${labelW}mm × ${labelH}mm`);

  // CSS parametrizado: en modo etiqueta usamos el tamaño exacto del sticker y
  // sin padding/fuente forzada (la plantilla de etiqueta trae lo suyo).
  const pageCss = labelMode
    ? `size: ${labelW}mm ${labelH}mm; margin: 0;`
    : `size: ${paperWidth} 200mm; margin: 0mm;`;
  const bodyCss = labelMode
    ? `width: ${labelW}mm; height: ${labelH}mm; margin: 0; padding: 0; background: white !important; color: #000000 !important;`
    : `font-family: 'Courier New', monospace; font-size: 14px; width: ${paperWidth}; margin: 0; padding: 5mm; background: white !important; color: #000000 !important;`;
  const bodyPrintCss = labelMode
    ? `width: ${labelW}mm; margin: 0; padding: 0; color: #000000 !important;`
    : `width: ${paperWidth}; margin: 0; padding: 5mm; color: #000000 !important;`;

  try {
    // Create hidden window for rendering
    const printWindow = new BrowserWindow({
      show: false,
      width: labelMode ? Math.max(120, Math.round((labelW / 25.4) * 96)) : (paperWidth === '58mm' ? 220 : 302),
      height: labelMode ? Math.max(80, Math.round((labelH / 25.4) * 96)) : 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    // Generate optimized HTML with thermal printer CSS
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          @page {
            ${pageCss}
          }
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            ${bodyCss}
          }
          @media print {
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color: #000000 !important;
            }
            body {
              ${bodyPrintCss}
            }
          }
        </style>
      </head>
      <body>${htmlContent}</body>
      </html>
    `;

    // Save HTML for debugging only when needed
    const backupDir = getBackupDir(app);
    let htmlPath = null;
    if (debugPdf) {
      htmlPath = path.join(backupDir, `print_native_${Date.now()}.html`);
      fs.writeFileSync(htmlPath, html, 'utf8');
    }

    // Load HTML and wait for actual DOM ready (much faster than fixed timeout)
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWindow.setTitle('TitanioPOS - Receipt');
    await printWindow.webContents.executeJavaScript('document.readyState');
    // Short grace period for fonts/layout (200ms instead of 2000ms)
    await new Promise(r => setTimeout(r, 200));

    const printOptions = {
      silent: true,
      deviceName: printerName,
      printBackground: true,
      color: false,
      margins: { marginType: 'none' },
      pageSize: labelMode
        ? { width: Math.round(labelW * 1000), height: Math.round(labelH * 1000) }
        : {
            width: paperWidth === '58mm' ? 58000 : 80000,
            height: 200000
          }
    };

    console.log('📄 [NATIVE] Print options:', JSON.stringify(printOptions, null, 2));

    // Generate PDF for debugging ONLY if explicitly enabled
    let pdfPath = null;
    if (debugPdf) {
      try {
        const pdfBuffer = await printWindow.webContents.printToPDF({
          marginsType: 1,
          pageSize: labelMode
            ? { width: Math.round(labelW * 1000), height: Math.round(labelH * 1000) }
            : {
                width: paperWidth === '58mm' ? 58000 : 80000,
                height: 200000
              },
          printBackground: true
        });
        pdfPath = path.join(backupDir, `print_native_${Date.now()}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);
        console.log('📄 [NATIVE] Debug PDF generated at', pdfPath);
      } catch (e) {
        console.warn('⚠️ [NATIVE] Could not generate debug PDF:', e.message);
      }
    }

    // Execute print
    return new Promise((resolve) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        console.log(success ? '✅ [NATIVE] Print sent' : `❌ [NATIVE] Failed: ${failureReason}`);
        printWindow.close();

        // Cleanup HTML file after delay
        if (htmlPath) {
          setTimeout(() => {
            try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath); } catch (e) {}
          }, 5000);
        }

        resolve({
          success,
          method: 'Native Electron Print API',
          htmlPath,
          pdfPath,
          error: success ? undefined : failureReason
        });
      });
    });
  } catch (error) {
    console.error('❌ [NATIVE] Error:', error);
    return { success: false, error: error.message };
  }
}

/**
 * METHOD 2: ESC/POS RAW Commands via Windows Spooler API
 * 
 * RECOMMENDED for production and low-end CPUs.
 * Sends raw bytes directly to the Windows printer spooler using PowerShell
 * with inline C# (no temporary .ps1 script file).
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {string} printerName - Windows printer name
 * @param {string} textContent - Plain text content to print (already includes ESC/POS)
 * @param {string} usbPort - USB port (e.g., 'USB003')
 * @returns {Promise<Object>} Result with success status
 */
async function printWithESCPOS(app, printerName, textContent, usbPort = 'USB003') {
  console.log('🖨️ [ESC/POS] Starting RAW print job');

  return new Promise((resolve) => {
    try {
      const backupDir = getBackupDir(app);
      const tempFile = path.join(backupDir, `escpos_${Date.now()}.prn`);

      // Generate ESC/POS commands
      const ESC = '\x1B';
      const GS = '\x1D';

      let data = '';
      data += ESC + '@';          // Initialize printer
      data += textContent;         // Main content (already includes ESC/POS)
      data += '\n\n\n';
      data += GS + 'V' + '\x00';  // Cut paper

      // Save ESC/POS commands to a single temp file
      fs.writeFileSync(tempFile, data, 'binary');
      console.log('📄 [ESC/POS] Commands file created:', tempFile);
      console.log(`📌 [ESC/POS] USB Port: ${usbPort}`);

      // Build PowerShell script (inline, no .ps1 file)
      // Reads the .prn file and sends to printer via winspool
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
        di.pDocName = "TitanioPOS Receipt";
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

      // Encode as Base64 UTF-16LE for -EncodedCommand (avoids quoting issues and .ps1 file)
      const encodedCmd = Buffer.from(psScript, 'utf16le').toString('base64');
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodedCmd}`;

      console.log('🖨️ [ESC/POS] Executing inline PowerShell');

      exec(cmd, { timeout: 15000 }, (error, stdout, stderr) => {
        if (stdout) console.log(`   [ESC/POS] Output: ${stdout.trim()}`);
        if (stderr) console.log(`   [ESC/POS] Error: ${stderr.trim()}`);

        const success = !error && stdout.includes('SUCCESS');

        if (success) {
          console.log('✅ [ESC/POS] Print successful');
        } else {
          console.log('❌ [ESC/POS] Print failed');
        }

        // Cleanup temp file immediately
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}

        resolve({
          success,
          method: 'ESC/POS RAW via Windows Spooler API',
          file: tempFile,
          usbPort,
          error: success ? undefined : (error?.message || 'Print command failed')
        });
      });
    } catch (error) {
      console.error('❌ [ESC/POS] Error:', error);
      resolve({ success: false, error: error.message });
    }
  });
}

module.exports = {
  printWithNativeAPI,
  printWithESCPOS
};
