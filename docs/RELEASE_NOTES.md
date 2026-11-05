# Notas de release (lo que ve el jugador)

El launcher muestra el **body del GitHub Release** en el modal **Novedades**.

**Público:** un usuario normal. Habla claro, sin jerga de desarrollo.
Nada de tags (`content-v*`), SHA, firmas, CI, nombres de zip técnicos ni docs internas.
Si no lo entendería tu abuela o un amigo que solo quiere jugar, no va aquí.

Aplica al release del launcher (`unaisdev/hortelanos-daily`) y a los packs
de cada juego (`dailygold`, `dailyred`).

## Plantilla

```text
## Novedades

- Arreglado: el menú se quedaba en negro al volver del combate.
- Ahora puedes ver las novedades del launcher sin salir a GitHub.

## Descarga

- En Windows: baja el zip portable, descomprímelo y ábrelo. No hace falta instalar nada.
```

La sección **Novedades** es lo único que importa en la app.
**Descarga** (opcional) puede ir debajo en la página de GitHub; el modal la ignora.
Lo técnico (checksums, builds, repos de packs) vive en `docs/`, no en el body.

## Qué sí poner

- Bugs que el jugador note (pantallas rotas, combates que fallan, menús).
- Controles o pantallas nuevas.
- Cambios de reglas o de comportamiento del juego / del menú.
- Cosas que “se sienten distintas” al abrir el launcher o un cartucho.

## Qué no poner

- Refactors, rendimiento, CI, dependencias, detalles internos.
- “Builds sin firma”, SHA, `content-v*`, nombres de assets, flags de build.
- Enlaces a docs técnicas (`UNSIGNED_INSTALL.md`, etc.).

Si un release no tiene Novedades útiles, el launcher mostrará “Sin notas en este release”.
