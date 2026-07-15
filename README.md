# TitanioPOS Desktop

Electron wrapper for the TitanioPOS web application. It loads the configured frontend URL, adds **local order backup** (JWT-backed), optional **fiscal device** integration via an embedded Python bridge, **pinpad/LAN proxy** helpers, and **auto-updates** through `electron-updater`.

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [npm scripts](#npm-scripts)
- [Building installers locally](#building-installers-locally)
- [CI/CD (GitHub Actions)](#cicd-github-actions)
- [Auto-updates](#auto-updates)
- [Security practices](#security-practices)
- [Repository layout](#repository-layout-high-level)
- [License](#license)
- [Support](#support)

---

## Features

| Area | Description |
|------|-------------|
| **Shell** | Single main window; loads the PWA from `TITANIOPOS_URL` (or local default). |
| **Single instance** | A second launch exits immediately; the running instance is focused. |
| **Backups** | IPC APIs to persist orders locally; payloads use JWT (shared secret with your stack). |
| **Fiscal** | Optional local fiscal server (Python); port and tooling path configurable via environment. |
| **Updates** | Packaged builds can check GitHub Releases (see **Auto-updates**). |
| **DevTools** | Optional password gate; optional auto-open for development (see **Configuration**). |

---

## Requirements

- **Windows** (primary target for installers; development may use other platforms with limitations).
- **Node.js** 20.x (aligned with CI).
- **npm** for dependencies.
- **Python** on the POS machine only if you use the fiscal bridge (see `.env.example`).

---

## Quick start

```bash
git clone <your-fork-or-mirror>
cd titaniopos-electron
npm ci
```

1. Copy **`.env.example`** to **`.env`** and set non-secret defaults (see below).
2. Ensure the frontend is reachable at the URL you set (e.g. local dev server).
3. Run:

```bash
npm start
```

Artifacts from local packaging appear under **`dist/`** after a build.

---

## Configuration

All runtime configuration is documented in **`.env.example`**. Copy it to `.env` and adjust values.

### Core variables

| Variable | Purpose |
|----------|---------|
| `TITANIOPOS_URL` | Full URL of the web app. If empty, the app uses `http://localhost:3001`. |
| `TITANIOPOS_JWT_SECRET` | Secret for signing/verifying local backup JWTs. **Treat as confidential.** Use a strong random value; align with backend policy if data must interoperate. |

### Developer Tools

| Variable | Purpose |
|----------|---------|
| `TITANIOPOS_OPEN_DEVTOOLS_ON_START` | When `true` (`1`, `yes`, `on`), DevTools open on startup and no password is required for shortcuts/menu. |
| `TITANIOPOS_DEVTOOLS_PASSWORD` | When the flag above is **not** enabled, users must enter this value to open DevTools (F12 / View menu). |

**Recommendation for production POS devices:** keep `TITANIOPOS_OPEN_DEVTOOLS_ON_START` off and set a strong `TITANIOPOS_DEVTOOLS_PASSWORD` known only to support.

### Fiscal bridge (optional)

| Variable | Purpose |
|----------|---------|
| `FISCAL_SERVER_PORT` | Port for the fiscal Python service (default in app: `3000` if unset). |
| `INTFHKA_PATH` | Optional path to fiscal vendor tooling on disk. |

### Local release publishing (optional)

| Variable | Purpose |
|----------|---------|
| `GH_TOKEN` | Personal access token **only** if you run `npm run release` / `npm run publish` **from your machine** to push to GitHub. **Never commit this.** CI uses the repository token instead. |

---

## npm scripts

| Script | Description |
|--------|-------------|
| `npm start` | Run Electron against the current project (uses `.env` when present). |
| `npm run build` | Windows NSIS + portable targets; **does not** publish. |
| `npm run build:portable` | Portable executable only; **does not** publish. |
| `npm run release` | Build and **publish** to the provider configured under `package.json` → `build.publish`. |
| `npm run publish` | Same as `release` in this project. |

Exact artifact names (installer vs portable) are defined in **`package.json`** → `build` (e.g. `artifactName` fields).

---

## Building installers locally

1. Configure `.env` as needed (at minimum `TITANIOPOS_URL` and `TITANIOPOS_JWT_SECRET` for realistic runs).
2. Run:

```bash
npm run build
```

3. Collect outputs from **`dist/`**.

To publish a release from your PC you need a valid **`GH_TOKEN`** with permission to create releases on the configured repository; prefer CI for production releases.

---

## Instalación lenta en las cajas (10-20 min)

El instalador NSIS extrae miles de archivos pequeños y **Windows Defender escanea
cada uno en tiempo real** — en máquinas con HDD eso domina el tiempo de instalación.
Mitigaciones, en orden de impacto:

1. **Exclusión de Defender** (una vez por caja, PowerShell como admin — suele
   recortar ~70% del tiempo, y evita la carrera Defender-vs-archivos al arrancar):

   ```powershell
   Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Programs\TitanioPOS"
   ```

2. **Vista horneada dentro del app.asar** (hecho en v1.0.71): ~2.000 archivos
   menos que extraer; la vista viaja como un solo archivo y el proxy la lee del
   asar directo. Solo aplica a vistas estáticas.

3. **Pendiente si sigue lento**: `python-embed/` (2.162 archivos del server
   fiscal) → convertirlo en zip que se auto-extrae al primer arranque en
   `userData`, con marcador de versión para no re-extraer.

Nota: las actualizaciones del **shell** llegan solas por `electron-updater`
(GitHub Releases publica `latest.yml` + blockmap desde v1.0.67: descarga
diferencial en segundo plano, instala al cerrar). Las de la **vista** llegan por
el feed (`updates.titanio-pos.com`) sin reinstalar nada. Reinstalar a mano solo
hace falta para cambios profundos del shell en una caja sin el updater.

---

## CI/CD (GitHub Actions)

The workflow **`.github/workflows/release-windows.yml`** builds on **Windows** and publishes when:

- You push a version tag matching `v*` (e.g. `v1.2.3`), or  
- You run the workflow manually (**Actions** → **Release Windows** → **Run workflow**).

The job writes a **`.env`** file from repository configuration **before** packaging:

### Actions variables (non-secret)

| Name | Role |
|------|------|
| `TITANIOPOS_URL` | Production frontend URL baked into the build. If missing, the workflow falls back to `http://localhost:3001` (useful to detect misconfiguration). |
| `TITANIOPOS_OPEN_DEVTOOLS_ON_START` | Optional. If unset, the workflow sets **`false`** (recommended for customer-facing installers). |

### Actions secrets

| Name | Role |
|------|------|
| `TITANIOPOS_JWT_SECRET` | Embedded JWT secret for the packaged app. |
| `TITANIOPOS_DEVTOOLS_PASSWORD` | Optional; used when DevTools are password-gated on deployed builds. |

Configure these under **GitHub → Repository → Settings → Secrets and variables → Actions**. Do not paste secrets into issues, logs, or the README.

---

## Auto-updates

Packaged apps use **`electron-updater`**. Update metadata and binaries are expected from the **GitHub Releases** integration configured in **`package.json`** (`build.publish`).

**Operational note:** the releases feed and assets must be reachable by the installed app without embedding personal tokens. Private repositories often return **404** to unauthenticated clients; plan visibility of release assets accordingly.

---

## Security practices

1. **Never commit `.env`** — it is listed in `.gitignore`. Use **`.env.example`** as the template only.
2. Rotate **`TITANIOPOS_JWT_SECRET`** and **`TITANIOPOS_DEVTOOLS_PASSWORD`** if they are exposed.
3. Revoke any leaked **personal access tokens** immediately in your Git provider settings.
4. DevTools and JWT secrets reduce casual abuse but are **not** a substitute for full device hardening or network policy.

---

## Repository layout (high level)

| Path | Role |
|------|------|
| `main.js` | Main process: window, menus, IPC, backups, DevTools policy, updater hooks. |
| `preload.js` | Context-isolated bridge exposed to the renderer as `window.electronAPI`. |
| `fiscal-handlers.js` / `pinpad-handlers.js` | Feature-specific IPC backends. |
| `fiscal-server-manager.js` | Lifecycle for the optional Python fiscal service. |
| `fiscal-server/` | Python fiscal bridge sources. |
| `.github/workflows/` | CI release pipeline. |

---

## License

**MIT** — see `package.json` (`license` field) for the declared license string.

---

## Support

For build or release issues, inspect the **Actions** run logs and confirm **Variables** / **Secrets** match **`.env.example`**. For application behavior, verify `TITANIOPOS_URL` and JWT configuration first.
