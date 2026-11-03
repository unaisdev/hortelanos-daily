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
- Daily Gold viene con pack local (`games/dailygold`, ROM incluida para desarrollo)
- Daily Red aparece en el menú pero **espera content pack** (el repo fuente no publica la ROM)

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

## Escritorio / Releases

- Builds unsigned por plataforma (macOS / Windows / Ubuntu). Guía: [docs/UNSIGNED_INSTALL.md](docs/UNSIGNED_INSTALL.md).
- Updates previstos vía GitHub Releases (launcher + `*-content.zip` por juego).

## Licencias

Fan project. Emulador y tipografías: ver `runner/licenses.txt`. Pokémon © Nintendo / Creatures / GAME FREAK.
