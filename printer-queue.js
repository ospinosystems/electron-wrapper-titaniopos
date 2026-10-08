/**
 * TitanioPOS - Cola de impresión de Windows (tickera)
 *
 * Electron entrega cada ticket al spooler de Windows y este contesta "ok" en
 * cuanto acepta el trabajo, no cuando sale el papel. Lo que quede guardado en
 * la cola (impresora apagada, apagón con trabajos a medias, archivos de spool
 * que Windows reencola al arrancar) sale de golpe cuando la impresora vuelve a
 * responder: la "pila de tickets" al encender la caja.
 *
 * Este módulo vacía la cola de la tickera configurada en dos momentos: al
 * arrancar la app (nadie pidió un ticket todavía) y al confirmar el cierre de
 * caja (lo pide la vista por IPC). Solo borra trabajos; no toca la impresora,
 * el puerto ni la configuración. Los trabajos de la etiquetera y la fiscal no
 * se tocan: van por otras impresoras.
 */

const { exec } = require('child_process');

const PURGE_TIMEOUT_MS = 20000;

/** Literal de PowerShell entre comillas simples (la comilla se duplica). */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Script de PowerShell que borra los trabajos de `printerName`. Con
 * `olderThanSeconds` > 0 respeta lo recién encolado (un ticket que está
 * saliendo en este momento). Imprime "REMOVED n OF m" para poder contarlos.
 */
function buildPurgeScript(printerName, olderThanSeconds = 0) {
  const age = Number(olderThanSeconds) > 0 ? Math.floor(Number(olderThanSeconds)) : 0;
  const filter = age > 0 ? ` | Where-Object { $_.SubmittedTime -lt (Get-Date).AddSeconds(-${age}) }` : '';
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$jobs = @(Get-PrintJob -PrinterName ${psQuote(printerName)}${filter})`,
    '$n = 0',
    'foreach ($j in $jobs) { try { Remove-PrintJob -InputObject $j -ErrorAction Stop; $n++ } catch {} }',
    'Write-Output ("REMOVED " + $n + " OF " + $jobs.Count)',
  ].join('\n');
}

function parsePurgeOutput(stdout) {
  const m = /REMOVED (\d+) OF (\d+)/.exec(String(stdout || ''));
  if (!m) return null;
  return { removed: Number(m[1]), found: Number(m[2]) };
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    // -EncodedCommand: sin archivo .ps1 ni problemas de comillas (igual que printer-methods).
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

/**
 * Vacía la cola de `printerName`. Nunca lanza: devuelve
 * { success, removed, found, error? }. `run` se inyecta en los tests.
 */
async function purgePrinterQueue(printerName, { olderThanSeconds = 0, run = runPowerShell } = {}) {
  const name = String(printerName || '').trim();
  if (!name) return { success: true, removed: 0, found: 0, skipped: 'no-printer' };
  try {
    const { error, stdout, stderr } = await run(buildPurgeScript(name, olderThanSeconds), PURGE_TIMEOUT_MS);
    const parsed = parsePurgeOutput(stdout);
    if (error || !parsed) {
      const detail = (error && error.message) || String(stderr || '').trim() || String(stdout || '').trim() || 'sin respuesta';
      return { success: false, removed: 0, found: 0, error: detail };
    }
    return { success: true, ...parsed };
  } catch (e) {
    return { success: false, removed: 0, found: 0, error: e.message };
  }
}

/**
 * Vacía la cola de la tickera configurada en el settings (si hay una).
 * Lazy require de printer-config: necesita Electron, y este módulo se prueba sin él.
 */
async function purgeTicketPrinterQueue(options = {}) {
  let printerName = '';
  try {
    printerName = require('./printer-config').loadConfig().printerName || '';
  } catch (e) {
    console.warn('⚠️ [PRINT-QUEUE] No se pudo leer la impresora configurada:', e.message);
    return { success: false, removed: 0, found: 0, error: e.message };
  }
  const result = await purgePrinterQueue(printerName, options);
  if (result.skipped) {
    console.log('🧹 [PRINT-QUEUE] Sin tickera configurada; nada que vaciar');
  } else if (result.success) {
    console.log(`🧹 [PRINT-QUEUE] ${printerName}: ${result.removed} de ${result.found} trabajos borrados de la cola`);
  } else {
    console.warn(`⚠️ [PRINT-QUEUE] ${printerName}: no se pudo vaciar la cola: ${result.error}`);
  }
  return result;
}

module.exports = { buildPurgeScript, parsePurgeOutput, purgePrinterQueue, purgeTicketPrinterQueue };
