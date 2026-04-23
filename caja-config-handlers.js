/**
 * Nº caja, pinpad, modo — sección "caja" de titaniopos-settings.json
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const {
  getSettingsPath,
  readSettings,
  writeSettings,
  normalizeCaja,
  DEFAULT_CAJA,
} = require('./titaniopos-settings-file');

const loadCajaConfig = (app) => {
  return normalizeCaja(readSettings(app).caja);
};

const saveCajaConfig = (app, config) => {
  try {
    const s = readSettings(app);
    s.caja = normalizeCaja({ ...s.caja, ...(config && typeof config === 'object' ? config : {}) });
    writeSettings(app, s);
    console.log('[CAJA] Config guardada (unificado):', getSettingsPath(app));
    return { success: true, config: s.caja };
  } catch (error) {
    console.error('[CAJA] Error saving caja config:', error);
    return { success: false, error: error.message };
  }
};

function registerCajaConfigHandlers(app) {
  ipcMain.handle('caja-config-get', async () => {
    try {
      const configPath = getSettingsPath(app);
      const hasFile = fs.existsSync(configPath);
      const config = loadCajaConfig(app);
      return { success: true, config, path: configPath, hasFile };
    } catch (error) {
      return { success: false, error: error.message, config: { ...DEFAULT_CAJA }, hasFile: false };
    }
  });

  ipcMain.handle('caja-config-save', async (event, partial) => {
    return saveCajaConfig(app, partial && typeof partial === 'object' ? partial : {});
  });
}

module.exports = {
  registerCajaConfigHandlers,
  getCajaConfigPath: getSettingsPath,
  loadCajaConfig,
  DEFAULT_CAJA_CONFIG: DEFAULT_CAJA,
};
