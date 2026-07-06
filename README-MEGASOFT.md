# Megasoft VPOS (Mega POS) — mapa de la integración

Integración del punto de venta Megasoft (Merchant Server + pinpad Verifone P200)
en TitanioPOS. Este documento lista las rutas de todos los archivos que la
componen y los datos operativos de producción.

## Datos de producción (correo Megasoft 2026-07-06)

| Dato | Valor |
|---|---|
| Merchant Server | `ssl.megasoftve.com` |
| Puerto | `4763` (conexión SSL) |
| VPOS | 3.16.0 REST (Java 21 embebido) |
| VTID / afiliación | **Uno por caja** — pendiente de que Megasoft los genere |
| Cajas | Maracay 5, Guacara 7, Tinaquillo 4 (total 16) |
| Bancos | Bancaribe y Banesco (TDC/TDD) |
| Razón social | Comercializadora y Distribuidora el Arabito 222, F.P. — RIF V-216282228 |
| Aplicativo declarado | ArabitoFacturacion v1.0 (integrador: Titanio Group 1 C.A) |

Ambiente de certificación (histórico): `200.71.151.226:24300`, vtid `GTITANIO01`, id `0001`.

## Archivos de este repo (proceso main de Electron)

| Archivo | Qué hace |
|---|---|
| `mega-pos-manager.js` | Arranca/detiene el VPOS como proceso Java hijo (clase `ve.com.megasoft.vpos.service.VposWebService`, REST en `127.0.0.1:8085`). Copia la distribución a userData, reescribe los `.ini` con la config de la caja y sondea `/vpos/ping` hasta 30 s. |
| `mega-pos-handlers.js` | Handlers IPC: `mega-pos-transaction` (compra/anulación), `mega-pos-task` (cierre, precierre, reimpresión), `mega-pos-ping`, `mega-pos-read-voucher`, `mega-pos-install-driver`, `mega-pos-detect-pinpad`. Aprobado = `codRespuesta === "00"`. Timeout de transacción: 2 min, sin reintentos. |
| `main.js` (buscar `mega-pos-`) | Handlers de config: `mega-pos-config-get/save` (save reinicia el servicio), `mega-pos-restart`, `mega-pos-config-dump/files`, `mega-pos-read-config-file`. |
| `preload.js` (buscar `megaPos`) | Expone los métodos `megaPos*` al renderer vía contextBridge. |
| `titaniopos-settings-file.js` | Bloque `megaPos` del settings unificado: `enabled`, `serverHost`, `serverPort`, `ssl`, `vtid`, `id`. Defaults = producción; solo hay que cargar vtid/id por caja. |
| `vpos-rest/` | Distribución VPOS 3.16.0 de Megasoft (~268 MB). **NO está en git** (`.gitignore`); se empaqueta vía `extraResources` en `package.json`. Los instaladores del CI salen SIN ella — solo los builds locales la incluyen. |
| `drivers/verifone/` | Instalador MSI del driver Verifone P200 (queda en COM9) + detección (`VfiDevManager.exe`). |

## Archivos de configuración del VPOS

La app reescribe estos archivos **en cada arranque del servicio** a partir del
settings; editar los `.ini` a mano no sirve (se pisan al reiniciar).

| Archivo | Claves que escribe la app |
|---|---|
| `vpos-rest/conf/vposconf.ini` | `[server] host/port` (Merchant), `[SSL] active` (1 en prod), `[vtid] vtid/id` (caja), `[pinpad] marca=VERIFONE tipoPuerto=USB dataSensibleEncriptada=1`, `[pinpad-verifone] modelo=ENGAGE puerto=USB comandosNuevos=1 tipoPinblock=DUKPT dataSensibleEncriptada=1 mantenerConexion=1`. |
| `vpos-rest/conf/vposuniversal.ini` | `[COMPRA_MEDIOS_PAGO] activo=1` (requisito Megasoft; de fábrica viene en 0). |
| `vpos-rest/conf/confSeguridad.ini` | Credenciales internas del VPOS — no se toca. |

> Esquema pinpad 3.16.0: `marca`/`tipoPuerto`/`dataSensibleEncriptada` se
> mudaron de `[pinpad-verifone]` a `[pinpad]` (soporte multi-marca
> Verifone/Morefun). Los valores `comandosNuevos=1`/`DUKPT`/`encriptada=1`
> vienen de la certificación con 3.15.10 — **validar con el P200 real en
> 3.16.0 antes de desplegar a las 16 cajas**.

## Rutas en la caja (Windows)

| Ruta | Qué es |
|---|---|
| `%APPDATA%\titaniopos-electron\vpos-rest\` | Copia runtime escribible — desde aquí corre el VPOS y aquí se aplican los `.ini`. Se recopia sola cuando cambia la versión de la app **o** la de la distro (marcador `.installed-version` = `app:vpos-X.Y.Z`). |
| `Documentos\TitanioPOS-Settings\titaniopos-settings.json` | Settings unificado (bloque `megaPos`). Sobrevive updates de la app. |
| `C:\voucher\` | Vouchers `.txt` que escribe el VPOS (la app los lee con `mega-pos-read-voucher` para imprimir en la térmica). |
| `%USERPROFILE%\titaniopos-mega-pos.log` | Log del manager + stdout/stderr del VPOS. |

## Repos hermanos

| Archivo | Qué hace |
|---|---|
| frontend `src/lib/api/mega-pos-transaction.ts` | Cliente del flujo (Electron-only): `runMegaPosTransaction`, `runMegaPosTask`, `pingMegaPos`, `isMegaPosApproved`. Monto en céntimos de Bs. |
| frontend `src/components/checkout/payment/inline-payments/` | Tab "Mega POS" en el sheet de tarjeta (`payment-sheet.tsx`) + flujo de cobro (`inline-payments.tsx`). Gate: `megaPosEnabled` (OFF por defecto). |
| frontend `src/app/(auth)/settings/caja/page.tsx` | UI de administración (sección protegida): credenciales, SSL, probar/reiniciar servicio, driver, visor de config. |
| backend | Sin código específico: el pago entra como método `mega_pos` (id 82, `verify=false`) y el JSON del terminal se persiste en `orders_payments.pinpad_response`. |

## Checklist de despliegue por caja

1. Instalar la app (build local con `vpos-rest/` empaquetado, o copiar `vpos-rest/` a `resources\` aparte).
2. Conectar el P200 por USB e instalar el driver desde Settings → Caja ("Instalar driver (COM9)").
3. En Settings → Caja (sección protegida): cargar el **VTID** (terminal virtual que asigna Megasoft); host/puerto/SSL ya vienen por defecto en producción y el **id de caja** de `[vtid]` sale solo del número de caja configurado en la app (rellenado a 4 dígitos, p.ej. `0001` — requiere tener el número de caja configurado). Guardar — el servicio se reinicia solo. La afiliación bancaria NO se configura en la caja: los bancos la envían a Megasoft y vive en el Merchant Server asociada al VTID.
4. "Probar servicio" (ping) y hacer una compra de prueba con tarjeta real.
5. Encender el toggle "Mega POS" para que aparezca la tab en el cobro.

## Pendientes operativos con Megasoft

- VTIDs de las 16 cajas (sin ellos no se puede configurar ninguna caja).
- Enviar: correo para archivos de conciliación diaria, usuario Master de MegaBIS (nombre/apellido/correo) y 3 contactos del circuito de incidencias (proyecto, tesorería, tecnología).
- Afiliaciones/terminales de Bancaribe y Banesco (gestión con los bancos; mínimo 8 h hábiles antes de la implantación).
- Backup de la distro anterior: `C:\xampp\htdocs\projects\vpos-rest-3.15.10-bak`.
