# Instalación sin certificados

Hortelano's Daily se distribuye **sin firma de código**. El sistema operativo avisará; es esperado.

## macOS (Gatekeeper)

1. Descarga el `.dmg` o `.app` desde GitHub Releases.
2. Si macOS bloquea: clic derecho → **Abrir** → **Abrir**.
3. Alternativa Terminal: `xattr -dr com.apple.quarantine "/ruta/Hortelanos Daily.app"`.
4. Comprueba el hash con `SHA256SUMS` del Release.

## Windows (SmartScreen)

1. Ejecuta el `.exe` / instalador.
2. Si aparece SmartScreen: **Más información** → **Ejecutar de todas formas**.
3. Verifica SHA-256 del asset.

## Ubuntu / Linux

1. Descarga el `.AppImage`, `chmod +x` y ejecútalo.
2. Si usas `.deb`, instálalo con tu gestor de paquetes de confianza.
3. Verifica SHA-256.

## Desarrollo

```sh
# Solo navegador
node scripts/serve.mjs

# App desktop (Rust + WebView)
npm install
npm run desktop:dev
```

Abre la URL impresa del servidor web (por defecto http://localhost:8787) o la ventana Tauri.

## Verificar un instalador

Compara el hash del archivo descargado con `SHA256SUMS` del mismo Release:

```sh
shasum -a 256 "Hortelanos Daily.app"   # o el .dmg / .exe / .AppImage
```