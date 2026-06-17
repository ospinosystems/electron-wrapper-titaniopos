# rustdesk.exe (soporte remoto)

Colocá aquí el binario portable **rustdesk.exe** (descarga oficial:
https://github.com/rustdesk/rustdesk/releases — "rustdesk-x.y.z-x86_64.exe",
renombrarlo a `rustdesk.exe`).

`extraResources` ya empaqueta `bin/*.exe`, así que con dejarlo aquí queda
incluido en el build. La app lo usa para el soporte remoto desatendido
(ver remote-support-handlers.js). Apunta al servidor self-host propio
(rustdesk.titanio-pos.com, key del hbbs) — ya NO usa el relay público.
