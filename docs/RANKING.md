# Ranking diario (Daily Gold)

Victoria local → publish opcional a Cloudflare Worker + D1 → board solo en el launcher (shell). El runner envía el win en silencio.

## Estado actual

- Cliente + Worker desplegados.
- `shared/ranking-config.json` → `apiUrl` apunta al Worker; vacío = ranking desactivado.
- Onboarding en el launcher al entrar a Daily Gold; máx. 2 cambios de `@` por día UTC.

## Identidad

El jugador guarda su `@` de Instagram en el menú (`hortelano:player:instagram`). Si gana sin handle, el runner lo pide.

## Seguridad (Worker)

Ver README del servicio. Resumen: seed revalidada, rate limits, unique device/@ por día, límite de renombres, cap diario, body pequeño, whitelist de juegos. No hay prueba criptográfica del combate (cliente reporta win).

## Coste

Workers **Free**: $0; si se agota el cupo, falla el API, no factura. No uses plan Paid para esto.
