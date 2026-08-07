/**
 * Pre-build script: compiles the Direct Print Helper EXE
 * Run BEFORE electron-builder: npm run prebuild
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const BIN_DIR = path.join(__dirname, 'bin');
const EXE_NAME = 'TitanioPOSRawPrintHelper.exe';
const EXE_PATH = path.join(BIN_DIR, EXE_NAME);

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

function compile() {
  if (fs.existsSync(EXE_PATH)) {
    console.log(`[PREBUILD] ${EXE_NAME} already exists, skipping compilation`);
    process.exit(0);
  }

  const csc = findCsc();
  if (!csc) {
    console.error('[PREBUILD] ERROR: csc.exe not found. Install .NET Framework or Visual Studio Build Tools.');
    process.exit(1);
  }

  if (!fs.existsSync(BIN_DIR)) {
    fs.mkdirSync(BIN_DIR, { recursive: true });
  }

  const csPath = path.join(BIN_DIR, 'RawPrintHelper.cs');
  fs.writeFileSync(csPath, CS_SOURCE, 'utf8');

  console.log(`[PREBUILD] Compiling with ${csc}...`);
  execFile(csc, ['/target:exe', '/out:' + EXE_PATH, csPath], { timeout: 30000 }, (error, stdout, stderr) => {
    try { fs.unlinkSync(csPath); } catch (e) {}

    if (error) {
      console.error('[PREBUILD] Compilation failed:', error.message, stderr);
      process.exit(1);
    }

    const size = fs.statSync(EXE_PATH).size;
    console.log(`[PREBUILD] ✅ ${EXE_NAME} compiled (${size} bytes)`);
    console.log(`[PREBUILD] Location: ${EXE_PATH}`);
  });
}

/**
 * El host/key del RustDesk self-host viven duplicados en `remote-support-handlers.js`
 * (camino de la app) y `bin/setup-rustdesk.ps1` (camino del instalador NSIS), porque
 * PowerShell no puede importar del JS. Cuando divergen, las cajas instaladas por el
 * NSIS quedan apuntando a una key distinta que las configuradas por la app y RustDesk
 * corta con "Key mismatch" — pasó al rotar la key del hbbs. Abortar el build es mucho
 * más barato que descubrirlo en una caja en producción.
 */
function checkRustdeskConfigInSync() {
  const files = {
    'remote-support-handlers.js': path.join(__dirname, 'remote-support-handlers.js'),
    'bin/setup-rustdesk.ps1': path.join(BIN_DIR, 'setup-rustdesk.ps1'),
    'bin/rustdesk-apply-config.ps1': path.join(BIN_DIR, 'rustdesk-apply-config.ps1'),
  };
  for (const p of Object.values(files)) {
    if (!fs.existsSync(p)) return;
  }
  const read = (k) => fs.readFileSync(files[k], 'utf8');
  const grab = (src, re) => { const m = src.match(re); return m ? m[1] : null; };

  const js = read('remote-support-handlers.js');
  const setup = read('bin/setup-rustdesk.ps1');
  const apply = read('bin/rustdesk-apply-config.ps1');

  // Cada fila: qué valor es, y de dónde se lee en cada archivo que lo repite.
  const checks = [
    ['host', {
      'remote-support-handlers.js': grab(js, /RUSTDESK_HOST\s*=\s*'([^']+)'/),
      'bin/setup-rustdesk.ps1': grab(setup, /\$RdHost\s*=\s*'([^']+)'/),
      'bin/rustdesk-apply-config.ps1': grab(apply, /\$RdHost\s*=\s*'([^']+)'/),
    }],
    ['key', {
      'remote-support-handlers.js': grab(js, /RUSTDESK_KEY\s*=\s*'([^']+)'/),
      'bin/setup-rustdesk.ps1': grab(setup, /\$RdKey\s*=\s*'([^']+)'/),
      'bin/rustdesk-apply-config.ps1': grab(apply, /\$RdKey\s*=\s*'([^']+)'/),
    }],
    ['password', {
      'remote-support-handlers.js': grab(js, /DEFAULT_PASSWORD\s*=\s*'([^']+)'/),
      'bin/setup-rustdesk.ps1': grab(setup, /\$RdPassword\s*=\s*'([^']+)'/),
    }],
  ];

  for (const [what, sources] of checks) {
    const entries = Object.entries(sources);
    const missing = entries.filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      console.error(`[PREBUILD] ERROR: no se pudo leer el ${what} de RustDesk en: ${missing.join(', ')}`);
      process.exit(1);
    }
    const distinct = new Set(entries.map(([, v]) => v));
    if (distinct.size > 1) {
      console.error(`[PREBUILD] ERROR: el ${what} de RustDesk no coincide entre archivos.`);
      for (const [file, value] of entries) console.error(`  ${file}: ${value}`);
      console.error('  Deben ser idénticos o las cajas fallarán con "Key mismatch".');
      process.exit(1);
    }
  }
  console.log('[PREBUILD] ✅ RustDesk host/key/clave consistentes entre app, instalador y config del servicio');
}

checkRustdeskConfigInSync();
compile();
