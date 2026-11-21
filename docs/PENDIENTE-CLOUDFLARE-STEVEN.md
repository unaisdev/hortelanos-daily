# Pendiente de Cloudflare para Daily Steven

El ranking de Daily Steven aún no está activo en producción. El código está integrado en `cf01c0d385ef0dd3f3cb8324a1e278d702f25985`. [Daily Steven 0.1.2](https://github.com/unaisdev/dailysteven/releases/tag/untagged-e2ea13fd662c9a5c82a1) y [Hortelano's Daily 2.2.2](https://github.com/unaisdev/hortelanos-daily/releases/tag/untagged-f9c5d25488d15bf469ae) están preparados en borrador. La publicación queda pendiente de autorización.

## Estado verificado

- El Worker de producción es `hortelanos-daily-ranking`. Su binding `DB` debe apuntar a la D1 original definida en [services/ranking-api/wrangler.toml](../services/ranking-api/wrangler.toml), con ID `eca9b63a-3714-4c58-bf0e-9c478dc6d8c8`.
- Wrangler se autenticó, pero la cuenta visible carecía de acceso a los recursos originales. Cloudflare devolvió `10007` al consultar los despliegues del Worker y `7404` al consultar la D1. La versión activa y su binding quedaron pendientes de comprobación con la cuenta propietaria.
- Producción sigue intacta. `GET /health` anuncia solo `dailygold`. `GET /ranking` devuelve HTTP 200 para Gold y HTTP 400 con `invalid_game` para Steven.
- Las pruebas locales del nuevo ranking pasaron. Verificaron los prefijos `dailyoro:` y `dailysteven:`, la separación de clasificaciones, la validación de semillas y fechas y la deduplicación.

## Cómo retomar el despliegue

1. Iniciar sesión con acceso a la cuenta propietaria. Desde `services/ranking-api`, en una copia limpia del commit indicado, comprobar que existe el Worker y consultar su despliegue activo. Confirmar que el binding `DB` de esa versión apunta a la D1 original. Guardar el ID de la **versión** estable que recibe el tráfico para poder revertir.
2. Desplegar únicamente el Worker existente desde ese commit, conservando las variables de producción y el binding original.
3. Verificar por GET que `/health` anuncia `dailygold` y `dailysteven`. Consultar `/ranking?game=dailygold&date=AAAA-MM-DD` y `/ranking?game=dailysteven&date=AAAA-MM-DD`. Ambos deben devolver HTTP 200 con su propio `game_id`. Steven puede tener cero entradas. Confirmar que Gold sigue sirviendo su historial.
4. Si falla la verificación posterior, revertir al ID guardado con `wrangler rollback <ID_DE_VERSION_ANTERIOR> --name hortelanos-daily-ranking`. Volver a comprobar `/health` y el ranking de Gold. Registrar los IDs de versión, las comprobaciones y el resultado de la reversión si se utilizó.

Usar exclusivamente el Worker y la D1 originales. No crear otro Worker ni otra base. No ejecutar migraciones ni introducir victorias ficticias en producción.
