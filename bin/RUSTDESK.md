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

Mantener consistentes host/key/clave entre `setup-rustdesk.ps1` y
`remote-support-handlers.js`.
