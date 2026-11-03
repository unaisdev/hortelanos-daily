# Tauri 2 — Hortelano's Daily

Wrapper desktop (WebView + FS + downloader de content packs). **Sin firma de código** a propósito.

## Requisitos

- Node.js 18+
- Rust stable (`rustup`)
- macOS 11+ / Windows 10+ (WebView2) / Ubuntu 22.04+ (WebKitGTK 4.1)

```sh
# desde la raíz del repo
npm install
npm run desktop:dev    # app nativa + servidor local 127.0.0.1
npm run desktop:build  # instaladores en src-tauri/target/release/bundle/
```

La web pura sigue disponible con `npm run serve` / `node scripts/serve.mjs`.

## Qué hace el binario

1. Arranca un HTTP estático en `127.0.0.1` que sirve `shell/`, `runner/`, `catalog/` y `games/`.
2. Prioriza packs en el directorio de datos de la app (`…/hortelanos-daily/games/<id>/`) sobre los embebidos.
3. Expone comandos IPC:
   - `list_installed_packs` / `seed_local_packs`
   - `check_launcher_update` / `check_content_updates`
   - `install_content_pack` (download → SHA-256 → unzip atómico)
   - `verify_file_sha256` / `open_external_url`

## Updates

- Launcher: Release `v*` en `unaisdev/hortelanos-daily` (el usuario descarga el build de su SO).
- Content: Release `content-v*` en el repo de cada juego (`dailygold-content.zip`, etc.).
- En el menú desktop: tecla **U** o el botón de update.

## CI

`.github/workflows/release-launcher.yml` — matrix macOS / Ubuntu / Windows, draft Release + `SHA256SUMS`.
