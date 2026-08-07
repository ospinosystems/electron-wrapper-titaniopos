# rustdesk.exe (soporte remoto)

`rustdesk.exe` (binario oficial x86_64, actualmente 1.4.9) vive en esta carpeta
y va COMMITEADO al repo — `extraResources` empaqueta `bin/*.exe` y `bin/*.ps1`.

## Flujo (todo automático)

1. **Instalador NSIS** (`build/installer.nsh`): durante el setup de TitanioPOS
   (que ya corre elevado) ejecuta `setup-rustdesk.ps1` → instala el servicio de
   RustDesk apuntando al self-host (rustdesk.titanio-pos.com + key del hbbs) y
   fija la clave de acceso desatendido. La caja queda lista sin descargar ni
   activar nada. También corre en cada actualización de la app.
2. **Respaldo al arrancar** (`remote-support-handlers.js` →
   `startRemoteSupportIfEnabled`): si el servicio no está y el usuario NO lo
   desactivó con clave, se auto-instala (un único UAC), un intento por arranque.
3. **UI** (`settings/caja`): solo muestra el ID y el botón **Desactivar**, que
   exige la clave (`TITANIOPOS_REMOTE_DISABLE_PASSWORD`, default en el handler).
   Desactivar marca `disabledByUser` y el auto-install lo respeta; reinstalar o
   actualizar la app lo vuelve a activar.

Para actualizar el binario: descargar el release oficial
(https://github.com/rustdesk/rustdesk/releases, "rustdesk-x.y.z-x86_64.exe"),
renombrarlo a `rustdesk.exe` y reemplazarlo aquí.

## Rotar la key del hbbs

La key del servidor vive DUPLICADA en `setup-rustdesk.ps1` (`$RdKey`, camino del
instalador NSIS) y `remote-support-handlers.js` (`RUSTDESK_KEY`, camino de la
app), porque PowerShell no puede importar del JS. **Deben cambiar juntas**: si
divergen, o si el servidor rota su key y el cliente no, RustDesk corta con
`Connection error / Key mismatch` aunque el servicio esté corriendo y los
puertos abiertos. `npm run prebuild` aborta el build si no coinciden.

Para rotar: cambiar el valor en AMBOS archivos y publicar una versión nueva de
la app. Las cajas se corrigen solas por dos vías, sin reinstalar RustDesk:

- **Instalador/actualización NSIS** → `setup-rustdesk.ps1` re-aplica `--config` y
  reinicia el servicio si detecta que la key previa era otra (ya corre elevado,
  sin UAC).
- **Al arrancar la app** → `ensureServerKeyUpToDate` compara la key actual contra
  la del `RustDesk2.toml` del servicio y, si difiere, re-apunta y reinicia el
  servicio (un único UAC, una sola vez por rotación; queda anotado en
  `serverKey` de `remote-support.json`).

El reinicio del servicio no es opcional: sin él, el cliente sigue registrado en
el hbbs con la key vieja.
