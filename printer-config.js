/**
 * TitanioPOS - Thermal Printer Configuration Module
 * 
 * This module handles thermal printer configuration and provides
 * two reliable printing methods:
 * 1. Native Electron Print API (optimized for thermal printers)
 * 2. ESC/POS RAW commands via Windows Spooler API
 * 
 * Configuration is stored per-machine to support multi-PC deployments.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Get the printer configuration file path
 * Stored in user's AppData for per-machine configuration
 */
function getConfigPath() {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'printer-config.json');
}

/**
 * Default printer configuration
 */
const DEFAULT_CONFIG = {
  printerName: '',           // Windows printer name (e.g., "XP-58")
  usbPort: 'USB003',         // USB port for ESC/POS (e.g., "USB001", "USB002", "USB003")
  method: 'escpos',          // Preferred method: 'native' or 'escpos'
  paperWidth: '80mm',        // Paper width: '58mm' or '80mm'
  lastUpdated: null
};

/**
 * Load printer configuration from disk
 * @returns {Object} Printer configuration
 */
function loadConfig() {
  try {
    const configPath = getConfigPath();
    
    if (!fs.existsSync(configPath)) {
      console.log('📄 [PRINTER CONFIG] No config found, using defaults');
      return { ...DEFAULT_CONFIG };
    }
    
    const data = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(data);
    
    console.log('📄 [PRINTER CONFIG] Loaded:', config.printerName || 'Not configured');
    return { ...DEFAULT_CONFIG, ...config };
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
    const configPath = getConfigPath();
    const configToSave = {
      ...config,
      lastUpdated: new Date().toISOString()
    };
    
    fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), 'utf8');
    
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
