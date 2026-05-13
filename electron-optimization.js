/**
 * Electron Resource Optimizations for Low-End PCs (Celeron, 2-4GB RAM)
 *
 * Apply BEFORE app.ready. These flags disable Chromium bloat that kills
 * performance on integrated GPUs and low-memory systems.
 */

const { app } = require('electron');

function applyElectronOptimizations() {
  // 1. Disable hardware acceleration on weak integrated GPUs
  //    Celeron-era Intel HD Graphics drivers often cause more stutter than
  //    software rasterization. Electron falls back to CPU compositing.
  try {
    app.disableHardwareAcceleration();
    console.log('[PERF] Hardware acceleration disabled (Celeron/low-RAM mode)');
  } catch (e) {
    console.warn('[PERF] Could not disable hardware acceleration:', e.message);
  }

  // 2. Chromium switches — disable every non-essential subsystem
  const switches = [
    // GPU / Rendering
    ['disable-gpu', ''],
    ['disable-software-rasterizer', ''],
    ['disable-gpu-compositing', ''],
    ['disable-gpu-rasterization', ''],
    ['disable-gpu-sandbox', ''],
    ['disable-direct-composition', ''],
    ['disable-d3d11', ''],
    ['disable-angle', ''],

    // Memory savers
    ['disable-dev-shm-usage', ''],               // Avoid /dev/shm on Linux; on Windows does nothing harmful
    ['disable-features', [
      'SiteIsolationTrialOptOut',
      'IsolateOrigins',
      'site-per-process',
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
    ].join(',')],

    // Background throttling / networking
    ['disable-background-timer-throttling', ''],
    ['disable-renderer-backgrounding', ''],
    ['disable-backgrounding-occluded-windows', ''],
    ['disable-background-networking', ''],

    // Disable services that phone-home or run background tasks
    ['disable-component-update', ''],
    ['disable-default-apps', ''],
    ['disable-sync', ''],
    ['disable-speech-api', ''],
    ['disable-domain-reliability', ''],
    ['disable-breakpad', ''],
    ['disable-hang-monitor', ''],
    ['disable-ipc-flooding-protection', ''],
    ['disable-popup-blocking', ''],
    ['disable-prompt-on-repost', ''],

    // V8 / JS tuning
    ['js-flags', '--max-old-space-size=512 --optimize-for-size --no-concurrent-recompilation'],
  ];

  for (const [sw, value] of switches) {
    try {
      app.commandLine.appendSwitch(sw, value);
    } catch (e) {
      console.warn(`[PERF] Could not append switch ${sw}:`, e.message);
    }
  }

  console.log('[PERF] Low-end PC optimizations applied');
}

module.exports = { applyElectronOptimizations };
