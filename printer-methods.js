/**
 * TitanioPOS - Thermal Printer Methods Module
 * 
 * This module implements two reliable printing methods for thermal printers:
 * 
 * 1. NATIVE METHOD (Electron Print API):
 *    - Uses Chromium's print engine with thermal-optimized settings
 *    - Zero margins, exact color rendering, proper page sizing
 *    - Works well for HTML-based receipts
 * 
 * 2. ESC/POS RAW METHOD (Windows Spooler API):
 *    - Sends raw ESC/POS commands directly to printer
 *    - Uses Windows winspool.drv API with RAW datatype
 *    - Most reliable for thermal printers, bypasses driver issues
 *    - Recommended for production use
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
 * This method uses Electron's built-in print API with critical optimizations:
 * - Zero margins (thermal printers don't have margins)
 * - Color disabled (thermal printers only print black)
 * - Exact color rendering (prevents dithering)
 * - Fixed 80mm width (standard thermal paper)
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {string} printerName - Windows printer name
 * @param {string} htmlContent - HTML content to print
 * @param {string} paperWidth - Paper width ('58mm' or '80mm')
 * @returns {Promise<Object>} Result with success status
 */
async function printWithNativeAPI(app, printerName, htmlContent, paperWidth = '80mm') {
  console.log('🖨️ [NATIVE] Starting print job');
  
  try {
    // Create hidden window for rendering
    const printWindow = new BrowserWindow({
      show: false,
      width: paperWidth === '58mm' ? 220 : 302,  // 58mm ≈ 220px, 80mm ≈ 302px
      height: 800,
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
          /* CRITICAL: Page configuration for thermal printers */
          @page {
            size: ${paperWidth} 200mm;
            margin: 0mm;  /* Zero margins - thermal printers don't have margins */
          }
          
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          
          body {
            font-family: 'Courier New', monospace;
            font-size: 14px;
            width: ${paperWidth};  /* Fixed width prevents content shrinking */
            margin: 0;
            padding: 5mm;
            background: white !important;
            color: #000000 !important;  /* Pure black - no grays */
          }
          
          /* CRITICAL: Force exact color rendering */
          @media print {
            * {
              -webkit-print-color-adjust: exact !important;
              print-color-adjust: exact !important;
              color: #000000 !important;
            }
            
            body {
              width: ${paperWidth};
              margin: 0;
              padding: 5mm;
              color: #000000 !important;
            }
          }
        </style>
      </head>
      <body>
        ${htmlContent}
      </body>
      </html>
    `;

    // Save HTML for debugging
    const backupDir = getBackupDir(app);
    const htmlPath = path.join(backupDir, `print_native_${Date.now()}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    // Load HTML and wait for rendering
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    printWindow.setTitle('TitanioPOS - Receipt');
    await new Promise(r => setTimeout(r, 2000));  // Wait for full render

    // Print with thermal-optimized settings
    const printOptions = {
      silent: true,                    // No print dialog
      deviceName: printerName,         // Target printer
      printBackground: true,           // Print background colors
      color: false,                    // CRITICAL: Thermal printers don't use color
      margins: {
        marginType: 'none'             // CRITICAL: Zero margins
      },
      pageSize: {
        width: paperWidth === '58mm' ? 58000 : 80000,   // Width in microns
        height: 200000                                   // Height in microns (auto-cut)
      }
    };

    console.log('📄 [NATIVE] Print options:', JSON.stringify(printOptions, null, 2));

    // Generate PDF for debugging (saved in backupDir)
    let pdfPath = null;
    try {
      const pdfBuffer = await printWindow.webContents.printToPDF({
        marginsType: 1, // no margins
        pageSize: {
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

    // Execute print
    return new Promise((resolve) => {
      printWindow.webContents.print(printOptions, (success, failureReason) => {
        console.log(success ? '✅ [NATIVE] Print sent' : `❌ [NATIVE] Failed: ${failureReason}`);
        
        printWindow.close();
        
        // Cleanup HTML file after delay
        setTimeout(() => {
          try { if (fs.existsSync(htmlPath)) fs.unlinkSync(htmlPath); } catch (e) {}
        }, 5000);

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
 * This is the most reliable method for thermal printers. It:
 * 1. Generates raw ESC/POS commands (printer's native language)
 * 2. Uses Windows Spooler API (winspool.drv) to send data
 * 3. Sets datatype to "RAW" (bypasses Windows print processing)
 * 4. Writes directly to printer driver
 * 
 * This method works when others fail because it communicates
 * directly with the printer in its native command language.
 * 
 * @param {Electron.App} app - Electron app instance
 * @param {string} printerName - Windows printer name
 * @param {string} textContent - Plain text content to print
 * @param {string} usbPort - USB port (e.g., 'USB003')
 * @returns {Promise<Object>} Result with success status
 */
async function printWithESCPOS(app, printerName, textContent, usbPort = 'USB003') {
  console.log('🖨️ [ESC/POS] Starting RAW print job');
  
  return new Promise(async (resolve) => {
    try {
      const backupDir = getBackupDir(app);
      const tempFile = path.join(backupDir, `escpos_${Date.now()}.prn`);
      
      // Generate ESC/POS commands
      const ESC = '\x1B';  // Escape character
      const GS = '\x1D';   // Group separator
      
      let data = '';
      data += ESC + '@';                    // Initialize printer
      data += textContent;                   // Main content (already includes ESC/POS commands)
      data += '\n\n\n';
      data += GS + 'V' + '\x00';            // Cut paper
      
      // Save ESC/POS commands to file
      fs.writeFileSync(tempFile, data, 'binary');
      console.log('📄 [ESC/POS] Commands file created:', tempFile);
      
      // Create PowerShell script that uses Windows Spooler API
      // This is the KEY to making thermal printing work reliably
      const psScript = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class RawPrinter {
    // Windows Spooler API structures and functions
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
    
    // Main function to send raw bytes to printer
    public static bool SendBytesToPrinter(string szPrinterName, byte[] pBytes) {
        IntPtr hPrinter = IntPtr.Zero;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "TitanioPOS Receipt";
        di.pDataType = "RAW";  // CRITICAL: RAW datatype bypasses Windows print processing
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

if ($result) { 
    Write-Host 'SUCCESS' 
} else { 
    Write-Host 'FAILED'
    exit 1 
}
`;
      
      // Save PowerShell script to file
      const psScriptFile = path.join(backupDir, `print_${Date.now()}.ps1`);
      fs.writeFileSync(psScriptFile, psScript, 'utf8');
      
      console.log('📄 [ESC/POS] PowerShell script created');
      console.log(`📌 [ESC/POS] USB Port: ${usbPort}`);
      
      // Execute PowerShell script
      const cmd = `powershell -ExecutionPolicy Bypass -File "${psScriptFile}"`;
      
      exec(cmd, (error, stdout, stderr) => {
        if (stdout) console.log(`   [ESC/POS] Output: ${stdout.trim()}`);
        if (stderr) console.log(`   [ESC/POS] Error: ${stderr.trim()}`);
        
        const success = !error && stdout.includes('SUCCESS');
        
        if (success) {
          console.log('✅ [ESC/POS] Print successful');
        } else {
          console.log('❌ [ESC/POS] Print failed');
        }
        
        // Cleanup temporary files
        setTimeout(() => {
          try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch (e) {}
          try { if (fs.existsSync(psScriptFile)) fs.unlinkSync(psScriptFile); } catch (e) {}
        }, 3000);
        
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
