# UI local (abre sin internet)

El Electron sirve la UI desde un **build local empaquetado** del frontend Next.js,
en `http://127.0.0.1:3010`. Así la app **abre con o sin internet** y, como el origen
es siempre el mismo, se conservan sesión y datos locales (Electric SQL / PGlite / Dexie)
offline.

## Piezas

- `frontend-server-manager.js` — arranca el server standalone de Next como proceso
  hijo (Node embebido de Electron) en el puerto fijo **3010**, con readiness polling.
- `bundle-frontend.js` — copia `.next/standalone` + `.next/static` + `public` del
  frontend a `./frontend-server/` (lo que electron-builder empaqueta vía `extraResources`).
- `main.js` — `loadAppUI()` decide local vs remoto y muestra un splash mientras levanta.

## Modo local vs remoto

`main.js` usa local si hay bundle (`frontend-server/server.js` existe). Override:

- `TITANIOPOS_FRONTEND_MODE=local` — fuerza local.
- `TITANIOPOS_FRONTEND_MODE=remote` — fuerza la URL remota (`TITANIOPOS_URL`).

El puerto fijo NO debe cambiarse en una caja ya instalada: el origen
(`http://127.0.0.1:3010`) define dónde viven sesión y datos. Cambiarlo = empezar de cero.

## Build

```
# 1) En el frontend, build con NEXT_PUBLIC_* de PRODUCCIÓN (quedan horneados):
#    NEXT_PUBLIC_API_URL=<api prod>  NEXT_PUBLIC_ELECTRIC_URL=<electric prod>  ... npm run build
# 2) En el Electron:
npm run build:portable     # corre prebuild + bundle:frontend + electron-builder
```

`bundle:frontend` toma el frontend de `../titaniopos-frontend` (override con `FRONTEND_DIR`).

## PENDIENTE para producción

1. **CORS del backend Laravel**: como ahora la UI corre en `http://127.0.0.1:3010`,
   el backend debe permitir ese origen (CORS + cookies/sesión con `credentials`).
   Sin esto, online no carga datos (login/API fallan por CORS).

2. **Build con env de PROD**: el bundle de prueba se generó con el `.env` de dev
   (`NEXT_PUBLIC_API_URL=http://localhost:80`, electric en `localhost:3000`). Para una
   caja real hay que rebuildar el frontend apuntando a los servicios de producción.

3. **Actualizaciones de la web**: ahora la UI viaja dentro del instalador, así que cada
   cambio de la web requiere release del Electron (ya hay `electron-updater` configurado).
