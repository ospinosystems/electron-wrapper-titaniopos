/**
 * Electron Resource Optimizations for Low-End PCs (Celeron, 2-4GB RAM)
 *
 * IMPORTANT: This file takes a CONSERVATIVE approach.
 * We do NOT disable hardware acceleration because that forces Chromium to
 * render the entire UI on the CPU, which makes scrolling and animations
 * painfully slow on Celeron.
 *
 * Instead we:
 * 1. Limit V8 JS heap to avoid out-of-memory crashes / swap thrashing
 * 2. Disable Chromium features that consume background RAM/CPU
 * 3. Keep GPU acceleration ON for UI smoothness
 * 4. Disable spellcheck, background throttling, etc.
 */

const { app } = require('electron');

function applyElectronOptimizations() {
  // 1. Limit V8 heap to prevent Chromium from ballooning RAM usage.
  //    On 2-4GB systems, leaving V8 unbounded causes Windows to swap,
  //    which freezes the entire machine.
  try {
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');
    console.log('[PERF] V8 heap limited to 512 MB');
  } catch (e) {
    console.warn('[PERF] Could not set V8 flags:', e.message);
  }

  // 2. Disable Site Isolation — biggest RAM saver in Electron.
  //    Without this, Chromium spawns a renderer process per origin.
  //    On a single-page POS app this is pure waste.
  try {
    app.commandLine.appendSwitch('disable-features', [
      'site-per-process',
      'IsolateOrigins',
      'SiteIsolationTrialOptOut',
      'TranslateUI',
      'InterestFeedContentSuggestions',
      'MediaRouter',
      'OptimizationHints',
      'NetworkPrediction',
      'OfflinePagesPrefetching',
      'AutofillServerCommunication',
      'PasswordManager',
      'CreditCardAutofill',
      'SecurePaymentConfirmation',
    ].join(','));
    console.log('[PERF] Site Isolation + bloat features disabled');
  } catch (e) {
    console.warn('[PERF] Could not disable features:', e.message);
  }

  // 3. Background throttling — keep the POS responsive even when not focused
  try {
    app.commandLine.appendSwitch('disable-background-timer-throttling', '');
    app.commandLine.appendSwitch('disable-renderer-backgrounding', '');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows', '');
    console.log('[PERF] Background throttling disabled');
  } catch (e) {
    console.warn('[PERF] Could not disable throttling:', e.message);
  }

  // 4. Disable background networking (prediction, component updates, etc.)
  try {
    app.commandLine.appendSwitch('disable-background-networking', '');
    app.commandLine.appendSwitch('disable-component-update', '');
    app.commandLine.appendSwitch('disable-sync', '');
    app.commandLine.appendSwitch('disable-domain-reliability', '');
    console.log('[PERF] Background networking disabled');
  } catch (e) {
    console.warn('[PERF] Could not disable background networking:', e.message);
  }

  // 5. Disable GPU-related features that are known to cause stutter on
  //    old Intel HD Graphics drivers, but KEEP hardware acceleration ON.
  //    --disable-gpu-driver-bug-workarounds skips expensive driver workarounds.
  try {
    app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds', '');
    console.log('[PERF] GPU driver workarounds disabled (keeps HW accel ON)');
  } catch (e) {
    console.warn('[PERF] Could not disable GPU workarounds:', e.message);
  }

  console.log('[PERF] Conservative low-end PC optimizations applied');
}

module.exports = { applyElectronOptimizations };
