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
const os = require('os');
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

  // 5. GPU. Keep HW accel ON; skip driver workarounds that exist for browsers,
  //    not for kiosk apps. Push paint to GPU; cap raster threads to 1 because
  //    Celeron's 2 cores need to stay free for V8 and the fiscal-server pipe.
  app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('canvas-msaa-sample-count', '0');
  app.commandLine.appendSwitch('num-raster-threads', '1');

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
  // 1. Raise main process priority. On Win10+ a normal user can set their
  //    OWN process to HIGH without admin (SeIncreaseBasePriorityPrivilege
  //    is granted by default). If that ever fails we drop to ABOVE_NORMAL
  //    rather than leaving it at NORMAL.
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH);
    console.log('[PERF] Main process priority → HIGH');
  } catch (err) {
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      console.log('[PERF] Main process priority → ABOVE_NORMAL (HIGH denied:', err.message + ')');
    } catch (err2) {
      console.warn('[PERF] Could not raise main process priority:', err2.message);
    }
  }

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

// Renderer is born NORMAL priority even if main is HIGH — Chromium spawns it
// fresh and Windows assigns the default class. Call this from did-finish-load.
function raiseRendererPriority(webContents) {
  try {
    const pid = webContents.getOSProcessId();
    if (!pid) return;
    os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
    console.log('[PERF] Renderer PID', pid, '→ HIGH');
  } catch (err) {
    try {
      const pid = webContents.getOSProcessId();
      if (!pid) return;
      os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      console.log('[PERF] Renderer priority → ABOVE_NORMAL (HIGH denied)');
    } catch (err2) {
      console.warn('[PERF] Could not raise renderer priority:', err2.message);
    }
  }
}

module.exports = {
  applyElectronOptimizations,
  applyRuntimeOptimizations,
  raiseRendererPriority,
};
