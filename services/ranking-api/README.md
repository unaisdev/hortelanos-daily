# Ranking API (Cloudflare Workers Free + D1)

API compartida de “quién ha ganado hoy” para Daily Gold. **Sin deploy desde el agente** hasta que pegues credenciales.

## Coste

- Pensado para el plan **Workers Free** ($0).
- Si se agota el cupo diario, las peticiones fallan — **no factura**.
- No actives el plan Paid para este Worker.

## Cuando vuelvas (solo esto)

1. Cuenta Cloudflare + Node 18+.
2. En esta carpeta:

```sh
cd services/ranking-api
npm install
npx wrangler login
# o: export CLOUDFLARE_API_TOKEN=...  CLOUDFLARE_ACCOUNT_ID=...
npm run db:create
```

3. Copia el `database_id` que imprime el create en [`wrangler.toml`](wrangler.toml).
4. Migra y despliega:

```sh
npm run db:migrate:remote
npm run deploy
```

5. Pon la URL `https://hortelanos-daily-ranking.<subdomain>.workers.dev` en [`../../shared/ranking-config.json`](../../shared/ranking-config.json) → `apiUrl`.

Opcional (endurecer writes):

```sh
npx wrangler secret put SUBMIT_SECRET
```

Luego el cliente tendría que enviar header `x-hortelano-submit` (aún no cableado en el launcher; se puede añadir después).

## Endpoints

| Método | Ruta | Uso |
|--------|------|-----|
| GET | `/health` | Ping |
| GET | `/ranking?game=dailygold&date=YYYY-MM-DD` | Lista del día |
| GET | `/ranking/all[?game=]` | Ranking histórico por nº de victorias (todas las ROMs si no hay `game`), con racha actual |
| GET | `/player/<handle>[?game=]` | Ficha: rank, victorias, racha actual/mejor y historial (día + ROM, más reciente primero) |
| GET | `/avatar/<handle>` | Foto de perfil del jugador; `404` → la UI pinta la inicial |
| POST | `/avatar` | Subir/cambiar la foto del device (JPEG/PNG/WebP ≤ 16 KB) |
| POST | `/identity` | Registrar / renombrar `@` del device |
| POST | `/win` | Upsert victoria |

Body `/identity`:

```json
{
  "device_id": "uuid-local",
  "instagram": "usuario"
}
```

Primer `@` del device es gratis. Después, **máximo 2 cambios por día UTC** (el día lo decide el servidor; no se acepta fecha del cliente).

Un cambio de `@` **mueve todas las victorias pasadas al `@` nuevo** (el ranking lo refleja) y **quema el `@` antiguo**: nadie puede volver a reclamarlo, ni su dueño anterior, hasta que un admin lo libere (ver abajo).

Errores: `429 rename_limit` · `409 instagram_taken` (otro device lo usa) · `409 handle_released` (`@` quemado).

Body `/win`:

```json
{
  "game_id": "dailygold",
  "play_date": "2026-11-13",
  "seed": "1234567890",
  "instagram": "usuario",
  "device_id": "uuid-local"
}
```

## Seguridad (ya en el Worker)

- Whitelist de juegos + recompute de seed diaria (`dailyoro:`).
- Fechas de submit: solo hoy / ayer / mañana UTC (skew).
- Validación de `@` Instagram y `device_id`.
- Unique `(game, date, device)` y `(game, date, instagram)`.
- Identidad por device: máx. 2 renombres/día UTC (`rename_limit`); un `@` activo por device y `@` abandonados quemados (`released_handles`).
- Rate limit soft por IP.
- Cap 5k wins/día y body ≤ 2 KB.
- CORS configurable (`ALLOWED_ORIGINS`).
- Sin listados globales ni updates ajenos.

Límite honesto: el cliente puede mentir sobre haber ganado; no hay prueba ROM. Suficiente para comunidad fan con anti-spam.

## Administración: `@` bloqueados

Al renombrarse, el `@` antiguo se guarda en la tabla D1 `released_handles` y nadie puede volver a usarlo. Para liberarlo (por ejemplo, alguien se equivocó o se perdió una cuenta):

```sh
cd services/ranking-api
npx wrangler login                              # una vez (o CLOUDFLARE_API_TOKEN)

npm run admin:list-released                      # ver los @ bloqueados (D1 remota)
npm run admin:release-handle -- nombre_usuario   # liberar un @ (acepta @nombre)
```

Añade `--local` al final para operar contra la D1 de `wrangler dev`.

Alternativas equivalentes:

- **Dashboard de Cloudflare** → Storage & Databases → D1 → `hortelanos-daily-ranking` → Console:
  `DELETE FROM released_handles WHERE instagram = 'nombre_usuario';`
- **Wrangler directo**:
  `npx wrangler d1 execute hortelanos-daily-ranking --remote --command "DELETE FROM released_handles WHERE instagram = 'nombre_usuario'"`

Tras liberarlo, cualquier dispositivo puede reclamarlo con `POST /identity` (incluido su dueño anterior).

## Fotos de perfil

Instagram no ofrece una API pública estable para obtener la foto de cualquier @ (los servicios que lo hacen, como unavatar, son de pago), así que **la foto la elige el propio jugador**:

- Al unirse, o al pulsar el icono de cámara de la tarjeta de sesión, elige una imagen. El cliente la recorta al centro, la reduce a 128×128 y la comprime a JPEG (unos 3-10 KB).
- `POST /avatar` `{ device_id, image: "data:image/jpeg;base64,…" }` la guarda en D1 (`device_avatars`). Solo acepta JPEG/PNG/WebP reales (se comprueban los magic bytes), máx. 16 KB, y solo del dispositivo que ya tiene un `@` registrado.
- `GET /avatar/<handle>` sirve la foto del dispositivo que tiene ese `@` ahora; `404` → la UI pinta un círculo con la inicial.
- La foto se guarda por dispositivo, no por `@`: **si renombras, la foto te sigue**.
- Sin R2 ni servicios externos: coste $0.

> Límite honesto: nadie demuestra ser dueño de un `@` de Instagram, igual que ya pasaba con el nombre. El preview del onboarding incluye «Verificar en Instagram ↗» para que el jugador compruebe que escribió bien su `@`.

## Migraciones

`0004_avatars.sql` crea `device_avatars`. `0003_profiles.sql` crea `released_handles`, índices de historial y un índice único sobre `device_identities(instagram)`. Antes de aplicarla en remoto, comprueba que no haya duplicados:

```sh
npx wrangler d1 execute hortelanos-daily-ranking --remote --command "SELECT instagram, COUNT(*) n FROM device_identities GROUP BY instagram HAVING n > 1"
```
