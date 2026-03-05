/**
 * TitanioPOS - Pinpad IPC Handlers
 *
 * Local proxy for pinpad transactions from renderer to LAN pinpad device.
 */

const { ipcMain } = require('electron');
const http = require('http');

const DEFAULT_PINPAD_ADDRESS = '192.168.0.243:9001';
const DEFAULT_TIMEOUT_MS = 120000;

function normalizePinpadAddress(ipPinpad) {
  const raw = String(ipPinpad || '').trim();
  if (!raw) return DEFAULT_PINPAD_ADDRESS;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (!url.hostname) return DEFAULT_PINPAD_ADDRESS;
      const port = url.port || '9001';
      return `${url.hostname}:${port}`;
    } catch {
      return DEFAULT_PINPAD_ADDRESS;
    }
  }

  return raw;
}

function parsePinpadResponse(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

function capitalizeText(value) {
  if (!value || typeof value !== 'string') return value;
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function formatPinpadResponse(data) {
  if (!data || typeof data !== 'object') return data;

  const formatted = { ...data };
  if (typeof formatted.message === 'string') {
    formatted.message = capitalizeText(formatted.message);
  }
  if (typeof formatted.responsecode === 'string') {
    formatted.responsecode = capitalizeText(formatted.responsecode);
  }

  return formatted;
}

function postToPinpad({ pinpadAddress, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const [hostname, portValue] = String(pinpadAddress).split(':');
    const port = Number(portValue || 9001);

    const body = JSON.stringify(payload);

    const req = http.request(
      {
        hostname,
        port,
        path: '/transaction',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            ok: (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300,
            status: res.statusCode || 500,
            data: parsePinpadResponse(raw),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(`Pinpad request timeout (${Math.round(timeoutMs / 1000)}s)`);
      timeoutError.code = 'PINPAD_TIMEOUT';
      req.destroy(timeoutError);
    });

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function registerPinpadHandlers() {
  ipcMain.handle('pinpad-transaction', async (event, requestBody = {}) => {
    try {
      const {
        operation = 'COMPRA',
        amount,
        accountType,
        document,
        orderNumber,
        message = 'OspinoSystems',
        ipPinpad,
      } = requestBody;

      if (!amount || amount <= 0) {
        return { success: false, status: 400, error: 'Invalid amount' };
      }
      if (!document) {
        return { success: false, status: 400, error: 'Document (CI) is required' };
      }
      if (!orderNumber) {
        return { success: false, status: 400, error: 'Order number is required' };
      }

      const pinpadAddress = normalizePinpadAddress(ipPinpad);
      const payload = {
        operacion: operation,
        monto: amount,
        tipoCuenta: accountType || 'CORRIENTE',
        cedula: document,
        numeroOrden: orderNumber,
        mensaje: message,
      };

      console.log('[PINPAD] Request payload:', payload);
      console.log('[PINPAD] Target address:', pinpadAddress);

      const response = await postToPinpad({
        pinpadAddress,
        payload,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      return {
        success: response.ok,
        status: response.status,
        data: formatPinpadResponse(response.data),
      };
    } catch (error) {
      console.error('[PINPAD] Transaction error:', error);

      if (error && error.code === 'PINPAD_TIMEOUT') {
        return { success: false, status: 408, error: error.message };
      }

      return {
        success: false,
        status: 500,
        error: error?.message || 'Internal pinpad proxy error',
      };
    }
  });

  console.log('✅ [PINPAD] Handlers registered');
}

module.exports = {
  registerPinpadHandlers,
};
