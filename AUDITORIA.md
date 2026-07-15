# Auditoría del Sistema — Titanio POS

Documento de referencia para la evaluación de homologación (SENIAT). Describe
**qué cambios registra el sistema, dónde quedan almacenados y quién puede
consultarlos**, además de un registro cronológico de los cambios relevantes del
software.

> Alcance: el sistema registra los cambios operativos y fiscales sobre datos
> sensibles (productos, precios, órdenes, pagos, documentos fiscales) con el
> usuario responsable y el antes/después cuando aplica. La consulta se hace desde
> el Panel de Administración con un usuario de rol **auditor** (solo lectura).

---

## 1. Registros de auditoría en vivo

Cada uno de estos mecanismos deja traza persistente de los cambios realizados en
el sistema, identificando al usuario y el momento.

| Registro | Qué audita | Datos que guarda |
|----------|------------|------------------|
| **Historial de cambios de producto** (`product_change_history`) | Toda modificación de un producto / ítem de inventario | producto, tienda, ítem, **usuario**, campo modificado, **valor anterior → valor nuevo** |
| **Historial de precios** (`price_history`) | Cambios de precio por ítem de inventario | ítem, precio, fecha |
| **Respuestas fiscales** (`fiscal_responses`) | Cada documento fiscal emitido (factura / nota de crédito) | orden, tipo de documento, JSON íntegro devuelto por la máquina fiscal, fecha/hora fiscal |
| **Solicitudes de verificación / aprobación** (`transactions_request`) | Aprobaciones de descuentos, créditos, reembolsos, transferencias | tipo, estado (pendiente/aprobado/rechazado), aprobador, referencia |
| **Respuestas de punto de pago** (`pinpad_responses`) | Cada transacción con pinpad / VPOS | referencia, lote, código de respuesta, terminal, monto |

Todos los registros conservan `created_at` / `updated_at` (y el usuario cuando la
operación lo tiene asociado), de modo que cada cambio es rastreable en el tiempo.

---

## 2. Consulta de la auditoría (Panel de Administración)

Las siguientes vistas permiten revisar la traza sin modificar datos:

- **Auditoría de Órdenes** (`/admin/audit-orders`) — órdenes y su relación fiscal.
- **Auditoría del Sistema** (`/admin/system-orders`) — órdenes a nivel de sistema.
- **Auditoría de Pagos** (`/admin/payments`) — pagos y sus verificaciones (solo lectura).
- **Conversiones / tasas** (`/admin/developer/conversions`) — trazas de tasa de cambio aplicada.

---

## 3. Trazabilidad fiscal

- **Numeración fiscal:** la genera la máquina fiscal (The Factory HKA); el sistema
  almacena íntegra su respuesta en `fiscal_responses`, incluyendo el número y
  serial fiscal devueltos.
- **IGTF (3%):** los pagos en divisa cierran la factura con el medio de pago de
  divisa (código HKA 20-24), y la máquina calcula e imprime el IGTF. El código de
  divisa es configurable (`igtfDivisaCode`) sin recompilar.
- **Documentos no fiscales:** los comprobantes de la tiquera llevan la leyenda
  **"SIN DERECHO A CREDITO FISCAL"** y la indicación de exigir factura fiscal.
- **Forzar máquina fiscal:** con el interruptor *Forzar Máquina Fiscal* activo,
  cada venta emite factura fiscal y cada devolución su nota de crédito.

---

## 4. Control de acceso

- Roles y permisos gestionados con **spatie/laravel-permission**.
- Usuario **auditor**: rol de **solo lectura** con acceso a las vistas de
  auditoría; no puede crear, modificar ni eliminar datos.
- Las operaciones sensibles (descuentos, créditos, reembolsos, mover pagos) exigen
  aprobación con clave y quedan registradas en `transactions_request`.

---

## 5. Registro de cambios del software (changelog)

Cambios relevantes recientes, en orden cronológico inverso. La fuente de verdad es
el historial de commits de los tres repositorios (frontend, backend, electron/caja).

### Julio 2026 — Homologación e integridad fiscal
- Cableado del **IGTF (3%)**: el cierre fiscal usa el medio de pago real; los pagos
  en divisa disparan el IGTF en la máquina. Coletilla no fiscal en los recibos.
  Interruptor *Forzar Máquina Fiscal*.
- **Mega POS (Megasoft VPOS):** recuperación real desde archivos de control, visor
  de vouchers, auditoría de integridad y **cierre de fugas de dinero**; el pago
  pendiente sobrevive al corte y es lo que valida la recuperación; acciones de
  soporte ocultas tras gesto + clave (aprobar con voucher, mover pago).
- Rechazados de pago visibles como chip con detalle completo; cédula opcional en el
  cobro; confirmación antes de anular.

### Junio–Julio 2026 — Caja y despliegue
- **Vista exportable estática** de la caja (sin servidor Next embebido); publicación
  detrás del interruptor `CAJA_STATIC`; corrección de URLs absolutas → CORS.
- Buscador global del administrador; versiones en el sidebar.
- Hot-swap de la vista a demanda desde Ajustes.

### Junio 2026 — Órdenes, pagos e inventario
- **Sobrepago en transferencias**: cargar de más + reembolso del excedente, con
  restricciones de reembolso.
- Aprobación de **descuento por % efectivo** del total (con permiso de manager).
- **Transferencias de garantía** e inventario con alcance por tienda; devolución de
  stock en el resumen; aprobación de crédito **idempotente** (evita pagos dobles).
- Filtros y export CSV en órdenes de manager; búsqueda por id de sistema legado.

> Para el detalle exhaustivo (autor, fecha y diff de cada cambio) se consulta el
> historial de control de versiones de cada repositorio.
