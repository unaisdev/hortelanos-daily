# Instalación sin certificados

Hortelano's Daily se distribuye **sin firma de Apple / Microsoft**. El sistema avisará; es esperado.
No significa que el archivo esté corrupto.

## macOS (Gatekeeper)

1. Descarga el `.dmg` de **tu chip** desde GitHub Releases:
   - Apple Silicon (M1/M2/M3/…): `*_aarch64.dmg`
   - Intel: busca el dmg/x64 si está publicado (hoy CI publica `aarch64` en `macos-latest`).
2. Abre el DMG y arrastra **Hortelanos Daily** a Aplicaciones.
3. Si macOS dice que está **dañada** o no se puede abrir:
   - Clic derecho en la app → **Abrir** → **Abrir** (no hagas doble clic la primera vez).
   - O en Terminal:
     ```sh
     xattr -dr com.apple.quarantine "/Applications/Hortelanos Daily.app"
     open "/Applications/Hortelanos Daily.app"
     ```
4. Comprueba el hash con `SHA256SUMS` del Release si quieres.

Nota técnica: el build firma la app en ad-hoc (`signingIdentity: "-"`). Sin eso, macOS marca el `.app` como dañado aunque el DMG esté bien.

## Windows (SmartScreen)

**Recomendado — portable (sin instalar):**
1. Descarga `Hortelanos.Daily_*-x64-portable.zip`.
2. Descomprime en una carpeta (por ejemplo Escritorio).
3. Ejecuta `Hortelanos Daily.exe` **dejando en la misma carpeta** `shell/`, `runner/`, `catalog/` y `games/` (no muevas solo el `.exe`).
4. Si aparece SmartScreen: **Más información** → **Ejecutar de todas formas**.
5. Si la ventana dice `Not found`, el zip está incompleto o faltan esas carpetas junto al exe.

**Instalador (opcional):**
1. Ejecuta el `-setup.exe` o `.msi`.
2. Si aparece SmartScreen: **Más información** → **Ejecutar de todas formas**.
3. Verifica SHA-256 del asset.

Hace falta **WebView2** (suele venir en Windows 10/11). Si la ventana sale en blanco: [instalar WebView2](https://developer.microsoft.com/microsoft-edge/webview2/).

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
