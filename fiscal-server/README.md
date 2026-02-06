# Servidor Fiscal HKA - TitanioPOS

Servidor Python para comunicación con impresora fiscal HKA integrado con Electron.

## Requisitos

- Python 3.8+ instalado (con la opción **"Add Python to PATH"** marcada)
- Flask (`pip install flask`)
- Ejecutable `IntTFHKA.exe`

## Instalación rápida (Windows)

1) Instalar Python 3.10+ desde https://www.python.org/downloads/windows/ (marcar **"Add Python to PATH"**).
2) Verificar en PowerShell:
   ```powershell
   python --version
   pip --version
   ```
3) Instalar dependencias del servidor fiscal:
   ```powershell
   cd fiscal-server
   pip install -r requirements.txt
   ```
4) Colocar `IntTFHKA.exe` en **una** de estas rutas (se buscan en este orden):
   - `c:\xampp\htdocs\projects\titaniopos-electron\fiscal-server\IntTFHKA.exe` (recomendado, portable)
   - `C:\IntTFHKA\IntTFHKA.exe`
   - O definir variable de entorno `INTFHKA_PATH` apuntando al `.exe`

## Uso manual (si quieres probar sin Electron)

```bash
python fiscal.py
```
El servidor quedará en `http://localhost:3000` (o el puerto que definas en `FISCAL_SERVER_PORT`).

## Variables de entorno

- `INTFHKA_PATH`: Ruta al ejecutable IntTFHKA.exe (opcional; override de la búsqueda automática)
- `FISCAL_SERVER_PORT`: Puerto del servidor (default: 3000)

## Dónde se guardan datos temporales

- `fiscal-server/data/Factura.txt`: archivo temporal de facturas
- `fiscal-server/data/ids_caja_ejecutados.txt`: IDs de caja ya ejecutados

## Endpoints disponibles (para debug)

- `POST /fiscal` - Agregar factura/nota a la cola
- `GET /fiscal/estado/<job_id>` - Estado de un trabajo
- `GET /fiscal/cola/estado` - Estado de la cola
- `GET /fiscal/config` - Configuración actual
- `POST /fiscal/config/programa` - Configurar ruta del programa
- `GET /health` - Health check

## Integración con Electron (automático)

- El servidor Python se inicia al abrir la app Electron y se detiene al cerrarla.
- Rutas buscadas para `IntTFHKA.exe`: `INTFHKA_PATH` → `./IntTFHKA.exe` → `C:\IntTFHKA\IntTFHKA.exe`.
- Si Python no está instalado o el `.exe` no se encuentra, el servidor queda **Detenido**.

## Si la UI muestra "Python: Instalado" pero "Servidor: Detenido"

1. Verifica que `IntTFHKA.exe` esté en una de las rutas soportadas (o define `INTFHKA_PATH`).
2. Dale al botón **Reiniciar Servidor** en la UI de configuración.
3. Revisa que el puerto no esté ocupado (default 3000) o cambia `FISCAL_SERVER_PORT`.
4. Si sigue sin levantar, abre la consola de la app (Electron) y revisa logs `[FISCAL SERVER]`.

## ¿En qué puerto COM está conectada la máquina?

1. Abre **Administrador de dispositivos → Puertos (COM & LPT)**.
2. Busca algo como `USB Serial Device (COM3)` o `Prolific USB-to-Serial (COM4)`.
3. Ese COM se configura en la UI de `Máquina Fiscal (HKA)`.

## Notas

- El servidor es secuencial: procesa una tarea a la vez.
- Mantiene anti-duplicados por hash de petición.
- Guarda IDs de caja ejecutados para evitar reimpresiones.
