# Ranking diario (Daily Gold)

Victoria local → publish opcional a Cloudflare Worker + D1 → board solo en el launcher (shell). El runner envía el win en silencio.

## Estado actual

- Cliente + Worker desplegados.
- `shared/ranking-config.json` → `apiUrl` apunta al Worker; vacío = ranking desactivado.
- Onboarding en el launcher al entrar a Daily Gold; máx. 2 cambios de `@` por día UTC.
- Panel del launcher con pestañas **Hoy / Histórico** (más victorias, sumando ROMs).
- Pulsar un nombre abre la ficha del jugador: foto (o inicial), posición, victorias, racha actual/mejor e historial (día y ROM).
- Al poner o cambiar el `@` hay una tarjeta de **preview** (avatar + `@` tal como saldrá + «Verificar en Instagram ↗» + «Elegir foto»). La foto la sube el jugador (128×128 en D1); si no, sale la inicial.

## Cambiar de `@`

Botón de editar en la tarjeta de sesión. Avisa de que el `@` actual **se pierde para siempre**. Al cambiar, las victorias pasadas pasan al `@` nuevo y el ranking se actualiza. Máx. 2 cambios por día UTC (lo cuenta el servidor).

Para devolver un `@` bloqueado, ver «Administración» en [`services/ranking-api/README.md`](../services/ranking-api/README.md): `npm run admin:release-handle -- <handle>`.

## Rachas

Días naturales UTC consecutivos con victoria en la misma ROM. La racha sigue viva si la última victoria fue hoy o ayer. Función pura en `services/ranking-api/src/streaks.js` (test: `npm run test:streaks`).

## Identidad

El jugador guarda su `@` de Instagram en el menú (`hortelano:player:instagram`). Si gana sin handle, el runner lo pide.

## Seguridad (Worker)

Ver README del servicio. Resumen: seed revalidada, rate limits, unique device/@ por día, límite de renombres, cap diario, body pequeño, whitelist de juegos. No hay prueba criptográfica del combate (cliente reporta win).

## Coste

Workers **Free**: $0; si se agota el cupo, falla el API, no factura. No uses plan Paid para esto.
