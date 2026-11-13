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
| POST | `/identity` | Registrar / renombrar `@` del device |
| POST | `/win` | Upsert victoria |

Body `/identity`:

```json
{
  "device_id": "uuid-local",
  "instagram": "usuario",
  "change_date": "2026-11-13"
}
```

Primer `@` del device es gratis. Después, **máximo 2 cambios por día UTC**. Error `429` + `rename_limit` si se agota.

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
- Identidad por device: máx. 2 renombres/día UTC (`rename_limit`).
- Rate limit soft por IP.
- Cap 5k wins/día y body ≤ 2 KB.
- CORS configurable (`ALLOWED_ORIGINS`).
- Sin listados globales ni updates ajenos.

Límite honesto: el cliente puede mentir sobre haber ganado; no hay prueba ROM. Suficiente para comunidad fan con anti-spam.
