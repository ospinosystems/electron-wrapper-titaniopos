/**
 * TitanioPOS - Thermal Printer Configuration Module
 * 
 * This module handles thermal printer configuration and provides
 * two reliable printing methods:
 * 1. Native Electron Print API (optimized for thermal printers)
 * 2. ESC/POS RAW commands via Windows Spooler API
 * 
 * Configuration is stored in titaniopos-settings.json (sección thermalPrinter)
 */

const { app } = require('electron');
const { readSettings, writeSettings, normalizeThermal, getSettingsPath } = require('./titaniopos-settings-file');

/**
 * Ruta al JSON unificado (Documentos/TitanioPOS-Settings/…)
 */
function getConfigPath() {
  return getSettingsPath(app);
}

/**
 * Default printer configuration
 */
const DEFAULT_CONFIG = {
  printerName: '',
  usbPort: 'USB003',
  method: 'escpos',
  paperWidth: '80mm',
  lastUpdated: null,
};

/**
 * Load printer configuration from disk
 * @returns {Object} Printer configuration
 */
function loadConfig() {
  try {
    const merged = { ...DEFAULT_CONFIG, ...normalizeThermal(readSettings(app).thermalPrinter) };
    console.log('📄 [PRINTER CONFIG] Loaded:', merged.printerName || 'Not configured');
    return merged;
  } catch (error) {
    console.error('❌ [PRINTER CONFIG] Error loading config:', error.message);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Save printer configuration to disk
 * @param {Object} config - Configuration object
 * @returns {Object} Result with success status
 */
function saveConfig(config) {
  try {
    const s = readSettings(app);
    const configToSave = normalizeThermal({
      ...config,
      lastUpdated: new Date().toISOString(),
    });
    s.thermalPrinter = configToSave;
    writeSettings(app, s);
    console.log('💾 [PRINTER CONFIG] Saved:', configToSave.printerName);
    return { success: true, config: configToSave };
  } catch (error) {
    console.error('❌ [PRINTER CONFIG] Error saving config:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Validate printer configuration
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result
 */
function validateConfig(config) {
  const errors = [];
  
  if (!config.printerName || config.printerName.trim() === '') {
    errors.push('Printer name is required');
  }
  
  if (!config.usbPort || !config.usbPort.match(/^USB\d{3}$/)) {
    errors.push('USB port must be in format USB001, USB002, etc.');
  }
  
  if (!['native', 'escpos'].includes(config.method)) {
    errors.push('Method must be either "native" or "escpos"');
  }
  
  if (!['58mm', '80mm'].includes(config.paperWidth)) {
    errors.push('Paper width must be either "58mm" or "80mm"');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  validateConfig,
  getConfigPath,
  DEFAULT_CONFIG
};
