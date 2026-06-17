/**
 * TitanioPOS - Smart POS (Megasoft VPOS RESTService) IPC Handlers
 *
 * Proxy local para transacciones de PUNTO DE VENTA contra el componente
 * Megasoft "VPOS RESTService", que corre en la MISMA PC de la caja en
 * http://localhost:8085/vpos/...
 *
 * A diferencia del pinpad LAN (pinpad-handlers.js), el VPOS responde de forma
 * SÍNCRONA sobre localhost: el campo `codRespuesta` indica aprobado/rechazado
 * directamente, sin reconciliación contra un central server.
 *
 *   codRespuesta = "00"     -> Aprobada
 *   codRespuesta = "01".."99" -> Rechazada por el banco adquiriente
 *   codRespuesta = "VA".."VZ" -> Error de ejecución del VPOS
 *   codRespuesta = "XA".."XZ" -> Error del Merchant Server
 *
 * Manual de referencia: MAET-VPOSW (VPOS RESTService 1.0.7).
 */

const { ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// El VPOS RESTService escucha por defecto en 127.0.0.1:8085.
const DEFAULT_VPOS_HOST = '127.0.0.1';
const DEFAULT_VPOS_PORT = 8085;
// Una compra con tarjeta puede tomar tiempo (inserción de chip, PIN, banco).
const DEFAULT_TIMEOUT_MS = 120000;
const PING_TIMEOUT_MS = 4000;

const APPROVED_CODE = '00';

function resolveEndpoint(vposUrl) {
  const raw = String(vposUrl || '').trim();
  if (!raw) return { host: DEFAULT_VPOS_HOST, port: DEFAULT_VPOS_PORT };

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return {
      host: url.hostname || DEFAULT_VPOS_HOST,
      port: Number(url.port || DEFAULT_VPOS_PORT),
    };
  } catch {
    return { host: DEFAULT_VPOS_HOST, port: DEFAULT_VPOS_PORT };
  }
}

/**
 * montoTransaccion va SIN separadores, en la unidad mínima (formato nnnnnndd):
 * 1.234,56 -> "123456". El frontend ya envía el monto en céntimos (entero), así
 * que aquí solo lo normalizamos a string de dígitos.
 */
function formatMonto(amountInCents) {
  const n = Math.round(Number(amountInCents) || 0);
  return String(Math.max(0, n));
}

function parseJson(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { mensajeRespuesta: raw };
  }
}

function isApproved(data) {
  return data && typeof data === 'object' && String(data.codRespuesta) === APPROVED_CODE;
}

function postToVpos({ host, port, path, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
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
            status: res.statusCode || 500,
            data: parseJson(raw),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      const timeoutError = new Error(`VPOS request timeout (${Math.round(timeoutMs / 1000)}s)`);
      timeoutError.code = 'SMART_POS_TIMEOUT';
      req.destroy(timeoutError);
    });

    req.on('error', (err) => reject(err));
    req.write(body);
    req.end();
  });
}

function getToVpos({ host, port, path, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: host, port, path, method: 'GET' }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode || 500, body: raw }));
    });
    req.setTimeout(timeoutMs, () => {
      const e = new Error('VPOS ping timeout');
      e.code = 'SMART_POS_TIMEOUT';
      req.destroy(e);
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function registerSmartPosHandlers() {
  // -------- Compra / Anulación --------
  ipcMain.handle('smart-pos-transaction', async (event, requestBody = {}) => {
    try {
      const {
        operation = 'tarjeta', // 'tarjeta' (compra) | 'anulacion'
        amount, // céntimos (entero) — solo para compra
        document = '', // cédula / RIF
        numSeq, // secuencia a anular — solo para anulación
        terminalVirtual, // opcional (modo multiempresa)
      } = requestBody;

      const { host, port } = resolveEndpoint(requestBody.vposUrl);

      let payload;
      if (operation === 'anulacion') {
        if (!numSeq) {
          return { success: false, status: 400, error: 'numSeq es requerido para anular' };
        }
        payload = { accion: 'anulacion', cedula: String(document || ''), numSeq: String(numSeq) };
      } else {
        if (!amount || amount <= 0) {
          return { success: false, status: 400, error: 'Monto inválido' };
        }
        payload = {
          accion: 'tarjeta',
          montoTransaccion: formatMonto(amount),
          cedula: String(document || ''),
        };
      }
      if (terminalVirtual) payload.terminalVirtual = String(terminalVirtual);

      console.log('[SMART_POS] ->', `${host}:${port}/vpos/metodo`, payload);

      const response = await postToVpos({
        host,
        port,
        path: '/vpos/metodo',
        payload,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });

      console.log('[SMART_POS] <-', response.status, response.data && response.data.codRespuesta);

      return {
        success: isApproved(response.data),
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      console.error('[SMART_POS] Transaction error:', error);
      if (error && error.code === 'SMART_POS_TIMEOUT') {
        return { success: false, status: 408, error: error.message };
      }
      // ECONNREFUSED => el servicio VPOS no está corriendo en localhost:8085
      return {
        success: false,
        status: 500,
        error: error?.message || 'Error en el proxy VPOS',
      };
    }
  });

  // -------- Tareas (cierre, reimpresión de voucher, etc.) --------
  // Acciones sin parámetros adicionales: solo { accion }.
  const TASK_ACTIONS = new Set([
    'imprimeUltimoVoucher',
    'imprimeUltimoVoucherP',
    'precierre',
    'cierre',
    'ultimoCierre',
  ]);
  ipcMain.handle('smart-pos-task', async (event, requestBody = {}) => {
    try {
      const action = String((requestBody && requestBody.action) || '');
      if (!TASK_ACTIONS.has(action)) {
        return { success: false, status: 400, error: `Acción no permitida: ${action}` };
      }
      const { host, port } = resolveEndpoint(requestBody.vposUrl);
      console.log('[SMART_POS] tarea ->', `${host}:${port}/vpos/metodo`, action);
      const response = await postToVpos({
        host,
        port,
        path: '/vpos/metodo',
        payload: { accion: action },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      });
      return {
        // Para tareas, aprobado/ok lo determina codRespuesta "00" cuando aplica;
        // si no trae codRespuesta (p.ej. reimpresión), basta con HTTP 200.
        success: isApproved(response.data) || (response.status >= 200 && response.status < 300),
        status: response.status,
        data: response.data,
      };
    } catch (error) {
      console.error('[SMART_POS] Task error:', error);
      if (error && error.code === 'SMART_POS_TIMEOUT') {
        return { success: false, status: 408, error: error.message };
      }
      return { success: false, status: 500, error: error?.message || 'Error en el proxy VPOS' };
    }
  });

  // -------- Ping (servicio vivo) --------
  ipcMain.handle('smart-pos-ping', async (event, requestBody = {}) => {
    try {
      const { host, port } = resolveEndpoint(requestBody && requestBody.vposUrl);
      const res = await getToVpos({ host, port, path: '/vpos/ping', timeoutMs: PING_TIMEOUT_MS });
      return { success: res.status >= 200 && res.status < 300, status: res.status };
    } catch (error) {
      return { success: false, status: 0, error: error?.message || 'VPOS no responde' };
    }
  });

  // -------- Driver del pinpad Verifone (P200) --------
  // Resuelve drivers/verifone/<file> en dev y empaquetado.
  const getVerifoneFile = (file) => {
    const candidates = [];
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'drivers', 'verifone', file));
    candidates.push(path.join(__dirname, 'drivers', 'verifone', file));
    if (__dirname.includes('app.asar')) {
      candidates.push(path.join(__dirname.split('app.asar')[0], 'drivers', 'verifone', file));
    }
    return candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } }) || null;
  };

  // Instala el driver Verifone en modo silencioso y ELEVADO (UAC).
  // PORT=9 → el pinpad queda en COM9 (coincide con [pinpad] puerto=COM9 del VPOS).
  ipcMain.handle('smart-pos-install-driver', async () => {
    const msi = getVerifoneFile('VerifoneUnifiedDriverInstaller64.msi');
    if (!msi) return { success: false, error: 'El driver no está incluido en esta versión de la app.' };
    const args = `/qn /i "${msi}" PORT=9 SINGLE_DEVICE_SYSTEM=1 PORT_ROOT_LINK_NAME=COM FILE_LOGGING_OFF=1 IGNOREHWSERNUM=0`;
    return new Promise((resolve) => {
      const cmd = `Start-Process -Verb RunAs -Wait -FilePath 'msiexec.exe' -ArgumentList '${args.replace(/'/g, "''")}'`;
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true }, (error) => {
        if (error) return resolve({ success: false, error: 'No se pudo instalar (¿se canceló el permiso de administrador?).' });
        resolve({ success: true, message: 'Driver instalado (pinpad en COM9).' });
      });
    });
  });

  // Detecta puertos COM presentes y marca si hay un Verifone (prueba de conexión).
  ipcMain.handle('smart-pos-detect-pinpad', async () => {
    return new Promise((resolve) => {
      // El P200 (ENGAGE) trabaja por USB directo, no siempre aparece como (COMx).
      // Listamos tanto puertos COM como cualquier dispositivo Verifone/Engage por USB.
      const ps = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' -or $_.Name -match 'verifone|engage|vx |p200|mx9' -or $_.Manufacturer -match 'verifone' } | ForEach-Object { $_.Name } | Sort-Object -Unique | ConvertTo-Json -Compress";
      execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, (error, stdout) => {
        if (error) return resolve({ success: false, error: 'No se pudieron listar los dispositivos.' });
        let names = [];
        try { const j = JSON.parse(stdout.trim() || '[]'); names = Array.isArray(j) ? j : [j]; } catch { names = []; }
        names = names.filter(Boolean);
        const verifone = names.filter((n) => /verifone|vx |p200|mx9|engage/i.test(n));
        resolve({ success: true, ports: names, verifone, connected: verifone.length > 0 });
      });
    });
  });

  console.log('✅ [SMART_POS] Handlers registered');
}

module.exports = {
  registerSmartPosHandlers,
};
