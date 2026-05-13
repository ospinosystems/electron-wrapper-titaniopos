/**
 * TitanioPOS - Direct Windows Spooler Helper
 *
 * Sends RAW bytes directly to the Windows printer spooler using a pre-compiled
 * .EXE helper (TitanioPOSRawPrintHelper.exe) shipped with the app.
 *
 * MUCH faster than PowerShell + Add-Type on low-end CPUs because:
 * - No PowerShell startup overhead
 * - No C# runtime compilation
 * - Just a tiny .exe calling winspool.drv
 *
 * In development, compiles the EXE on-demand if not present.
 * In production, the EXE is shipped via electron-builder extraResources.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let helperPath = null;
let helperChecked = false;

const CS_SOURCE = `using System;
using System.Runtime.InteropServices;

class RawPrintHelper {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
    class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }
    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);
    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
    static extern bool ClosePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
    static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOA di);
    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
    static extern bool EndDocPrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
    static extern bool StartPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
    static extern bool EndPagePrinter(IntPtr hPrinter);
    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
    static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    static int Main(string[] args) {
        if (args.Length < 2) { Console.WriteLine("FAILED: args"); return 1; }
        try {
            string printerName = args[0];
            byte[] bytes = Convert.FromBase64String(args[1]);
            IntPtr hPrinter = IntPtr.Zero;
            DOCINFOA di = new DOCINFOA();
            di.pDocName = "TitanioPOS Receipt";
            di.pDataType = "RAW";
            bool ok = false;
            if (OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) {
                if (StartDocPrinter(hPrinter, 1, di)) {
                    if (StartPagePrinter(hPrinter)) {
                        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
                        Marshal.Copy(bytes, 0, p, bytes.Length);
                        int written;
                        ok = WritePrinter(hPrinter, p, bytes.Length, out written);
                        Marshal.FreeCoTaskMem(p);
                        EndPagePrinter(hPrinter);
                    }
                    EndDocPrinter(hPrinter);
                }
                ClosePrinter(hPrinter);
            }
            Console.WriteLine(ok ? "SUCCESS" : "FAILED: spooler");
            return ok ? 0 : 1;
        } catch (Exception ex) {
            Console.WriteLine("FAILED: " + ex.Message);
            return 1;
        }
    }
}`;

/**
 * Find the pre-compiled EXE shipped with the app.
 * In production (electron-builder), extraResources are placed in process.resourcesPath.
 * In development, the EXE should be in ./bin/ relative to this file.
 */
function findPrebuiltExe() {
  const exeName = 'TitanioPOSRawPrintHelper.exe';

  // 1. Production: electron-builder places extraResources in process.resourcesPath
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, 'bin', exeName);
    if (fs.existsSync(prodPath)) {
      console.log('[DIRECT] Found prebuilt EXE in resources:', prodPath);
      return prodPath;
    }
  }

  // 2. Development: relative to this file
  const devPath = path.join(__dirname, 'bin', exeName);
  if (fs.existsSync(devPath)) {
    console.log('[DIRECT] Found prebuilt EXE in dev bin:', devPath);
    return devPath;
  }

  return null;
}

function findCsc() {
  const candidates = [
    'C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v4.0.30319\\\\csc.exe',
    'C:\\\\Windows\\\\Microsoft.NET\\\\Framework\\\\v4.0.30319\\\\csc.exe',
    'C:\\\\Windows\\\\Microsoft.NET\\\\Framework64\\\\v2.0.50727\\\\csc.exe',
    'C:\\\\Windows\\\\Microsoft.NET\\\\Framework\\\\v2.0.50727\\\\csc.exe',
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function compileHelper(app) {
  return new Promise((resolve) => {
    const backupDir = path.join(app.getPath('documents'), 'TitanioPOS-Backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

    const exePath = path.join(backupDir, 'TitanioPOSRawPrintHelper.exe');

    const csc = findCsc();
    if (!csc) {
      console.warn('[DIRECT] csc.exe not found, cannot compile helper');
      resolve(null);
      return;
    }

    const csPath = path.join(backupDir, 'RawPrintHelper.cs');
    fs.writeFileSync(csPath, CS_SOURCE, 'utf8');

    console.log('[DIRECT] Compiling helper with', csc);
    execFile(csc, ['/target:exe', '/out:' + exePath, csPath], { timeout: 30000 }, (error, stdout, stderr) => {
      try { fs.unlinkSync(csPath); } catch (e) {}

      if (error) {
        console.error('[DIRECT] Compilation failed:', error.message, stderr);
        resolve(null);
      } else {
        console.log('[DIRECT] Helper compiled:', exePath);
        resolve(exePath);
      }
    });
  });
}

async function ensureHelper(app) {
  if (helperChecked) return helperPath;
  helperChecked = true;

  // 1. Try prebuilt (shipped with app)
  const prebuilt = findPrebuiltExe();
  if (prebuilt) {
    helperPath = prebuilt;
    return helperPath;
  }

  // 2. Try compiling on-the-fly (development only)
  console.log('[DIRECT] No prebuilt EXE found, attempting on-demand compilation...');
  const compiled = await compileHelper(app);
  helperPath = compiled;
  return helperPath;
}

async function printWithDirect(app, printerName, textContent) {
  const exe = await ensureHelper(app);
  if (!exe) {
    throw new Error('Direct helper not available (no prebuilt EXE and csc.exe not found)');
  }

  const ESC = '\x1B';
  const GS = '\x1D';
  let data = '';
  data += ESC + '@';
  data += textContent;
  data += '\n\n\n';
  data += GS + 'V' + '\x00';

  const base64 = Buffer.from(data, 'binary').toString('base64');

  return new Promise((resolve, reject) => {
    execFile(exe, [printerName, base64], { timeout: 15000 }, (error, stdout, stderr) => {
      const out = (stdout || '').trim();
      const success = !error && out.includes('SUCCESS');
      if (success) {
        console.log('✅ [DIRECT] Print successful');
        resolve({ success: true, method: 'Direct .EXE (winspool)' });
      } else {
        console.log('❌ [DIRECT] Print failed:', out, stderr);
        reject(new Error(out || stderr || 'Direct print failed'));
      }
    });
  });
}

module.exports = { printWithDirect, ensureHelper };
