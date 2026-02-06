# Servidor Fiscal HKA - TitanioPOS

Servidor Python para comunicación con impresora fiscal HKA integrado con Electron.

## Requisitos

- Python 3.8+ instalado (con la opción **"Add Python to PATH"** marcada)
- Flask (`pip install flask`)
- Ejecutable `IntTFHKA.exe` (SDK de HKA)

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

## Archivos requeridos en el directorio de IntTFHKA.exe

**IMPORTANTE:** Los siguientes archivos deben estar en el **MISMO DIRECTORIO** que `IntTFHKA.exe`:

- `Puerto.dat` - Contiene el puerto COM (ej: `COM6`)
- `Retorno.txt` - Archivo donde IntTFHKA escribe respuestas
- `Status_Error.txt` - Archivo donde IntTFHKA escribe estado/errores
- `Factura.txt` - Archivo temporal generado por el servidor para enviar a la impresora

## Configuración del Puerto COM

1. Abre **Administrador de dispositivos → Puertos (COM & LPT)**
2. Busca el puerto de la impresora fiscal (ej: `USB Serial Device (COM6)`)
3. Configura el puerto en la UI de TitanioPOS o usa el endpoint:
   ```bash
   curl -X POST http://localhost:3000/fiscal/config/puerto -H "Content-Type: application/json" -d '{"puerto": "COM6"}'
   ```

## Uso manual (si quieres probar sin Electron)

```bash
python fiscal.py
```
El servidor quedará en `http://localhost:3000` (o el puerto que definas en `FISCAL_SERVER_PORT`).

## Variables de entorno

- `INTFHKA_PATH`: Ruta al ejecutable IntTFHKA.exe (opcional; override de la búsqueda automática)
- `FISCAL_SERVER_PORT`: Puerto del servidor (default: 3000)

## Endpoints disponibles

### Documentos Fiscales
- `POST /fiscal` - Agregar factura/nota de crédito a la cola
- `GET /fiscal/estado/<job_id>` - Estado de un trabajo

### Configuración
- `GET /fiscal/config` - Configuración actual completa
- `POST /fiscal/config/programa` - Configurar ruta del programa IntTFHKA
- `GET /fiscal/config/puerto` - Obtener puerto COM actual
- `POST /fiscal/config/puerto` - Configurar puerto COM (escribe Puerto.dat)

### Diagnóstico
- `POST /fiscal/test-printer` - Probar conexión con la impresora fiscal
- `GET /fiscal/cola/estado` - Estado de la cola de trabajos
- `GET /health` - Health check del servidor

### Administración
- `GET /fiscal/ids-ejecutados` - Lista de IDs de caja ya procesados
- `DELETE /fiscal/ids-ejecutados` - Limpiar IDs ejecutados

## Formato de Factura (HKA)

```
iS*NOMBRE DEL CLIENTE
iR*V12345678
i05Caja: 1 - 00001
 000000500000001000PRODUCTO EXENTO
!000001000000002000PRODUCTO IVA 16%
101
```

### Códigos de Tasa IVA
- ` ` (espacio) = Exento (0%)
- `!` = Tasa General (16%)
- `"` = Tasa Reducida (8%)
- `#` = Tasa Adicional (31%)

### Formato de producto
`[TasaIVA][Precio12dígitos][Cantidad8dígitos][Descripción20chars]`

- Precio: En centavos, 12 dígitos (ej: 5.00$ = 000000000500)
- Cantidad: En milésimas, 8 dígitos (ej: 1.000 = 00001000)

### Códigos de cierre (forma de pago)
- `101` = Efectivo
- `102` = Débito
- `103` = Crédito
- `104` = Otros

## Formato de Nota de Crédito

```
iR*V12345678
iS*NOMBRE DEL CLIENTE
iF*00000000001
iD*15-01-2025
iI*ZPA2000343
ADEVOLUCION POR CAMBIO
i05Caja: 1 - 00002
d0000000500000001000PRODUCTO DEVUELTO
101
```

### Campos requeridos
- `iF*` = Número de factura original (11 dígitos)
- `iD*` = Fecha de factura original (DD-MM-YYYY)
- `iI*` = Serial de la impresora fiscal original

### Códigos de productos para devolución
- `d0` = Producto exento
- `d1` = Tasa General (16%)
- `d2` = Tasa Reducida (8%)
- `d3` = Tasa Adicional (31%)

## Códigos de retorno de IntTFHKA

- `0` = Error o sin respuesta
- `3` = Comando ejecutado correctamente (factura impresa)
- `4` = Comando ejecutado con advertencia
- `5` = Comando ejecutado

## Solución de Problemas

### "Error de comunicación con impresora fiscal"
1. Verifica que el puerto COM esté correctamente configurado en `Puerto.dat`
2. Verifica que la impresora esté encendida y conectada
3. Usa el endpoint `/fiscal/test-printer` para diagnosticar

### "Programa no encontrado"
1. Verifica que `IntTFHKA.exe` existe en la ruta configurada
2. Usa el endpoint `/fiscal/config` para ver la ruta actual

### "Timeout esperando respuesta"
1. Verifica la conexión física con la impresora
2. Revisa que el puerto COM sea el correcto
3. Reinicia la impresora fiscal

## Integración con Electron

- El servidor Python se inicia automáticamente al abrir la app
- Los handlers IPC disponibles:
  - `fiscal-config-get/save` - Configuración local
  - `fiscal-send-invoice` - Enviar factura/nota de crédito
  - `fiscal-check-job-status` - Consultar estado de trabajo
  - `fiscal-set-port` - Configurar puerto COM
  - `fiscal-test-printer` - Probar impresora
  - `fiscal-send-report-x/z` - Enviar reportes fiscales
  - `fiscal-server-start/stop/restart` - Control del servidor

## Notas

- El servidor es secuencial: procesa una tarea a la vez
- Mantiene anti-duplicados por hash de petición (5 minutos)
- Guarda IDs de caja ejecutados para evitar reimpresiones
- Los archivos `Factura.txt`, `Retorno.txt`, `Status_Error.txt` se crean en el directorio de IntTFHKA.exe
