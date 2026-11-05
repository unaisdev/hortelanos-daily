# Hortelano's Daily

Launcher de los **play-daily** (Daily Gold, Daily Red y futuros). Intro CRT → menú de cartuchos → runner mGBA WASM con protocolo versionado.

No sustituye a [dailygold](https://github.com/unaisdev/dailygold) ni [dailyred](https://github.com/amoi-builds/dailyred): esos repos siguen siendo dueños de patches/ROM. Este proyecto **consume** sus content packs.

## Inicio rápido (web, sin instalar nada raro)

Necesitas Node.js 18+.

```sh
node scripts/serve.mjs
# → http://localhost:8787/
```

- Intro retro en `/shell/`
- Daily Gold y Daily Red vienen con pack local (`games/dailygold`, `games/dailyred`; ROM incluida)

```sh
chmod +x scripts/verify-protocol.sh
scripts/verify-protocol.sh games/dailygold
```

## Arquitectura

| Capa | Rol |
|------|-----|
| `shell/` | Intro CRT + selección de juego |
| `runner/` | Cliente de combate + adapters de protocolo |
| `games/<id>/` | Content packs (`game.manifest.json` + ROM + assets) |
| `catalog/catalog.json` | Lista de dailies y metadatos |
| `src-tauri/` | Escritorio Tauri 2 (scaffold; builds multi-OS en CI) |

Stats y semillas van **aisladas por juego** (`hortelano:dailygold:stats`, `dailyoro:` vs `dailyred:`).

## Protocolo ROM

Ver [docs/PROTOCOL.md](docs/PROTOCOL.md). Hoy: `dailyred-conf-v2+status-v1`.

Orden al cambiar el contrato: **adapter en launcher → Release launcher → content pack**.

## Telemetría y errores

El launcher puede enviar **uso agregado** (aperturas, qué ROM se juega) y **errores** a Sentry, sin tracking de clics. Detalle de qué se recoge y cómo ampliarlo: [docs/TELEMETRY.md](docs/TELEMETRY.md).

Activación: pegar el DSN en `shared/telemetry.config.js` (`sentryDsn`). Vacío = desactivado.

## Escritorio (Tauri 2)

Necesitas Rust (`rustup`) además de Node:

```sh
npm install
npm run desktop:dev     # ventana nativa
npm run desktop:build   # instaladores en src-tauri/target/release/bundle/
```

- Builds **unsigned** por plataforma (macOS / Windows / Ubuntu). Guía: [docs/UNSIGNED_INSTALL.md](docs/UNSIGNED_INSTALL.md).
- En Windows hay **portable** (`*-x64-portable.zip`: descomprimir y ejecutar, sin instalador) además del setup.
- Updates vía GitHub Releases: launcher (`v*`) + content packs (`content-v*` en cada repo de juego).
- En el menú desktop: al abrir comprueba Releases y **auto-instala** content packs nuevos; **U** reintenta packs. Si hay launcher nuevo, la barra lo avisa con botón para abrir su release (sin autoabrir el navegador).
- Detalle Rust/IPC: [src-tauri/README.md](src-tauri/README.md).

## Versionado

Se sigue **siempre el sistema de versionado de GitHub Releases** (SemVer con prefijo):

| Qué | Tags en GitHub | Ejemplo |
|-----|----------------|---------|
| Launcher (este repo) | `vMAJOR.MINOR.PATCH` | [`v0.1.0`](https://github.com/unaisdev/hortelanos-daily/releases/tag/v0.1.0) |
| Content packs (repos de cada juego) | `content-vMAJOR.MINOR.PATCH` | `content-v0.1.0` |

- Cada release pública del launcher debe corresponder a un tag `v*` en este repo.
- Los packs de juego se versionan en su propio repo con tags `content-v*`; el launcher los resuelve desde ahí.
- No inventar esquemas paralelos: el número canónico es el del tag de GitHub Release.

## Licencias

Fan project. Emulador y tipografías: ver `runner/licenses.txt`. Pokémon © Nintendo / Creatures / GAME FREAK.
