/**
 * Electron Resource Optimizations — Profile: Celeron / 4 GB RAM POS box.
 *
 * The machine is DEDICATED to TitanioPOS: we can monopolize CPU/GPU/RAM
 * because there is no other workload that matters. Even so we DO NOT
 * disable hardware acceleration — forcing CPU compositing on Celeron is
 * worse than letting Intel HD render the UI.
 *
 * Two phases:
 *   - applyElectronOptimizations(): Chromium command-line flags. Must run
 *     BEFORE app.whenReady() because Chromium parses them at startup.
 *   - applyRuntimeOptimizations(): OS-level tweaks (process priority,
 *     Windows power plan). Must run AFTER app.whenReady() because we need
 *     the process to exist and child_process to be safe to spawn.
 *
 * A separate raiseRendererPriority(webContents) exists because the renderer
 * process is created lazily by Chromium — we can only set its priority once
 * `did-finish-load` fires and getOSProcessId() returns a real PID.
 */

const { app } = require('electron');
const { exec } = require('child_process');

const HIGH_PERF_POWER_GUID = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

function applyElectronOptimizations() {
  // 1. V8 heap — calibrated for Celeron 4 GB.
  //    Win10/11 idles ~1.5 GB, fiscal-server (Python) ~250 MB, leaves ~2.2 GB.
  //    768 MB renderer heap is the ceiling before Windows starts swapping.
  //    --expose-gc lets us force GC after print jobs (image buffers leak otherwise).
  app.commandLine.appendSwitch(
    'js-flags',
    '--max-old-space-size=768 --expose-gc'
  );
  console.log('[PERF] V8 heap → 768 MB, gc exposed');

  // 2. CRITICAL: every disable-features flag MUST go in a single call.
  //    Chromium's command-line parser only honors the LAST --disable-features
  //    value — duplicate switches silently overwrite each other.
  app.commandLine.appendSwitch(
    'disable-features',
    [
      // Site isolation — biggest single RAM win on a single-origin POS.
      'site-per-process',
      'IsolateOrigins',
      'SiteIsolationTrialOptOut',
      // UI / browser bloat we never use.
      'TranslateUI',
      'Translate',
      'InterestFeedContentSuggestions',
      'MediaRouter',
      'OptimizationHints',
      'NetworkPrediction',
      'OfflinePagesPrefetching',
      'AutofillServerCommunication',
      'PasswordManager',
      'CreditCardAutofill',
      'SecurePaymentConfirmation',
      // Per-paint / per-keystroke costs with zero POS value.
      'CalculateNativeWinOcclusion',
      'HardwareMediaKeyHandling',
      'WebRtcHideLocalIpsWithMdns',
      'IdleDetection',
      'LazyFrameLoading',
      // Costs more memory than it saves on a single-page app.
      'BackForwardCache',
    ].join(',')
  );
  console.log('[PERF] Site isolation + Chromium bloat features disabled');

  // 3. Background throttling — POS must stay responsive when unfocused
  //    (e.g. fiscal printer dialog steals focus mid-sale).
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  // 4. Telemetry + background networking. Pure savings, nothing breaks.
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('disable-crash-reporter');
  app.commandLine.appendSwitch('metrics-recording-only');
  app.commandLine.appendSwitch('no-default-browser-check');
  app.commandLine.appendSwitch('no-first-run');
  app.commandLine.appendSwitch('disable-default-apps');

  // 5. GPU pipeline.
  //
  // Diagnóstico previo (chrome://gpu vía IPC) mostró el problema concreto:
  //
  //   glImplementationParts: "(gl=none,angle=none)"   ← NINGÚN backend GL
  //   gpuDevice[*].active: false                       ← GPU detectada pero inactiva
  //   inProcessGpu: true                               ← GPU corre dentro del renderer
  //   directComposition: false                         ← Sin DirectComposition
  //   passthroughCmdDecoder: false                     ← Command decoder lento (validating)
  //
  // A pesar de que las features dicen "enabled", el pipeline real estaba caído
  // a software/in-process. Por eso animaciones CSS lagueaban con muchas filas.
  //
  // Los flags abajo FUERZAN el pipeline moderno de Chromium en Windows:
  //
  // - `use-angle=d3d11`: usa el backend ANGLE sobre Direct3D 11 (en vez de "auto"
  //   que en algunos sistemas falla a swiftshader/software). D3D11 es lo que
  //   usa Chrome y Edge nativamente y por eso son fluidos.
  //
  // - `use-cmd-decoder=passthrough`: command decoder pass-through (en vez del
  //   "validating" lento). Reduce overhead de cada draw call ~30-50%.
  //
  app.commandLine.appendSwitch('use-angle', 'd3d11');
  app.commandLine.appendSwitch('use-cmd-decoder', 'passthrough');

  // Compositing/raster — los que ya teníamos, sin cambios:
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('canvas-msaa-sample-count', '0');

  // 6. Disk cache. PWA loads from local XAMPP — bigger cache means fewer
  //    re-fetches when the user reloads or navigates. 150 MB is generous
  //    but disk is the cheapest resource on these boxes.
  app.commandLine.appendSwitch('disk-cache-size', String(150 * 1024 * 1024));
  app.commandLine.appendSwitch('media-cache-size', String(20 * 1024 * 1024));

  // 7. Renderer process limit — single POS window. Print windows are
  //    short-lived and get reused by Chromium's process model, so 1 is safe.
  app.commandLine.appendSwitch('renderer-process-limit', '1');

  console.log('[PERF] Chromium flags applied (Celeron 4GB profile)');
}

// Runs after app.whenReady(). Cannot run earlier — process.pid is fine but
// child_process from beforeReady can race with Electron's own init on Windows.
function applyRuntimeOptimizations() {
  // ───── PRIORITY HIGH DESACTIVADO ─────
  // Sospecha: poner el main en prioridad HIGH le quita CPU al DWM (Windows
  // Desktop Window Manager, el compositor del sistema) en momentos de
  // animación → animaciones choppy. Chrome web NO toca prioridades, por eso
  // anda fluido. Dejamos solo el power plan abajo.
  console.log('[PERF] Main priority manipulation DISABLED (testing if it was hurting animations)');

  // 2. Force Windows to "High Performance" power plan. On idle, Balanced
  //    drops the Celeron from ~2.4 GHz to ~800 MHz — that's the difference
  //    between a 200 ms first paint and a 1.5 s first paint. Built-in scheme
  //    GUID is identical across every Windows install since Vista.
  //    Without admin powercfg may refuse: that's fine, the NSIS installer
  //    sets it at install time too, so the runtime call is a safety net.
  if (process.platform === 'win32') {
    exec(`powercfg /setactive ${HIGH_PERF_POWER_GUID}`, (err) => {
      if (err) console.warn('[PERF] powercfg /setactive failed:', err.message);
      else console.log('[PERF] Windows power plan → High Performance');
    });
  }
}

// ───── RENDERER PRIORITY HIGH DESACTIVADO ─────
// Sospecha: poner el renderer en HIGH le roba CPU al DWM cuando necesita
// componer frames de animación. Chrome web no toca esto. Si se confirma que
// es el culpable, queda desactivado de forma permanente.
function raiseRendererPriority(_webContents) {
  console.log('[PERF] Renderer priority manipulation DISABLED');
}

module.exports = {
  applyElectronOptimizations,
  applyRuntimeOptimizations,
  raiseRendererPriority,
};
