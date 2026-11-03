# Tauri 2 scaffold

Aquí vivirá el wrapper desktop de Hortelano's Daily (WebView + FS + downloader de content packs).

Pendiente en este workspace:

1. Instalar Rust (`rustup`) y CLI Tauri 2.
2. `npm create tauri-app` / integrar `shell`+`runner` como frontend estático.
3. Comandos Rust: listar packs, verificar SHA-256, aplicar updates desde GitHub Releases.
4. CI matrix win/mac/linux → Release assets unsigned + `SHA256SUMS`.

Hasta entonces: `node scripts/serve.mjs`.
