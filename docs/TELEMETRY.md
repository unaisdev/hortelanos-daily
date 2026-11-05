# Telemetría y errores (Hortelano's Daily)

Documento **público** de qué datos recoge el launcher, para qué, y cómo ampliarlo.
El código vive en `shared/telemetry.js` (+ `shared/telemetry.config.js`).

## Objetivo

Entender la experiencia real de uso del launcher:

1. **Cuánta gente lo abre** (aprox. sesiones de menú).
2. **A qué ROM / cartucho juegan más** (`dailygold`, `dailyred`, futuros).
3. **Si hay problemas** (errores de arranque, carga de pack, emulador, updates).

**No** medimos clics de UI, rutas de menú, teclas, ni comportamiento fino dentro del combate.

## Qué se envía

| Evento / tipo | Cuándo | Datos |
|---------------|--------|--------|
| `launcher.open` | Al mostrar el menú de cartuchos, **una vez por pestaña/sesión** | `launcher_version`, `games_available`, `roms` (`id:contentVersion` separados por coma, p. ej. `dailygold:0.1.0,dailyred:0.1.0`) |
| `game.launch` | Cuando el emulador **arranca** una partida | `gameId`, `content_version` (versión del pack/ROM), `protocol_id`, `launcher_version`, `practice` |
| Error (Sentry exception) | Fallos capturados o no controlados en shell/runner | mensaje, stack truncado, `surface` (`shell` \| `runner`), `gameId` si aplica, `where` |

Contexto común en todos los envíos:

- `platform`: `web` o `desktop`
- `launcher_version` (catálogo; en desktop se prefiere la del IPC)
- `install-id`: UUID anónimo en `localStorage` (aproxima instalaciones, **no** es una cuenta)

## Qué **no** se recoge

- Clics, hovers, navegación entre cartuchos en el menú
- Inputs de teclado / pad durante el juego
- Contenido de la ROM, saves, seeds diarias, stats locales de victorias
- Nombre, email, cuentas o identificadores personales
- IP como PII explícita (`ip_address` se fuerza a `null` en el payload; el proveedor puede ver la IP de red a nivel de transporte)

Si en el futuro se añade un evento, **debe** documentarse en esta tabla antes de mergearlo.

## Backend y secretos (no van a GitHub)

Hoy: **Sentry** (proyecto Browser) vía envelope HTTP, sin SDK npm.

**El DSN no se commitea.** Defaults públicos en `shared/telemetry.config.js` (`sentryDsn: ''`). El valor real entra solo por:

| Modo | Cómo |
|------|------|
| Local | `.env` (gitignored) con `HORTELANO_SENTRY_DSN=…`, o copia `shared/telemetry.secrets.example.js` → `shared/telemetry.secrets.js` |
| Inject | `npm run telemetry:inject` / automático en `serve` y `prepare:desktop-www` |
| Release CI | GitHub Actions secret **`HORTELANO_SENTRY_DSN`** → `scripts/inject-telemetry-secrets.mjs` antes del build |

Archivos que **nunca** deben subirse:

- `shared/telemetry.secrets.js` (gitignore)
- `.env` (gitignore)

Sin DSN → **no se envía nada** (no-op seguro).

> Nota: un DSN de Sentry browser es write-only, pero igual preferimos no publicarlo en el repo. En el binario/release desktop queda embebido en el frontend (inevitable en cliente); lo que evitamos es exponerlo en el historial de git.

### Activar en local

```sh
cp .env.example .env
# edita HORTELANO_SENTRY_DSN=
npm run serve
```

### Activar en releases

1. Crear proyecto Sentry (Browser).
2. Repo → **Settings → Secrets and variables → Actions** → New secret:
   - Name: `HORTELANO_SENTRY_DSN`
   - Value: el DSN
3. El workflow `release-launcher` inyecta el secret al construir. Sin el secret, los builds salen con telemetría apagada.

En Sentry:

- Issues = problemas / crashes.
- Events con mensaje `launcher.open` / `game.launch` (tag `event`, tag `game_id`) = uso y popularidad de ROM.
- Filtrar Discover / Dashboards por `event:game.launch` y desglosar por `game_id`.

## Cómo ampliar (eventos nuevos)

1. Añadir la constante en `EVENTS` dentro de `shared/telemetry.js`.
2. Llamar a `track(EVENTS.NUEVO, { … })` desde shell o runner (solo primitivos).
3. **Actualizar esta tabla** con nombre, cuándo y campos.
4. No enviar objetos grandes, blobs, paths de usuario ni PII.

Ejemplo futuro (aún no implementado): `pack.update_failed` con `gameId` + código de error.

## Opt-out / depuración

- Sin DSN → telemetría apagada.
- `?debugTelemetry` en la URL → logs en consola (`[telemetry] …`) sin cambiar el envío.

## Privacidad (resumen)

Fan project. Telemetría mínima orientada a **fiabilidad y producto** (uso agregado + errores), no a perfiles de jugador. Este archivo es la fuente de verdad de lo que prometemos recoger.
