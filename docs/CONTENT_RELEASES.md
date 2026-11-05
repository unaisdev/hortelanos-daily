# Content packs en GitHub Releases

Cada juego publica su propio zip. El launcher solo lo descarga y verifica.

## Convención

| Campo | Valor |
|-------|--------|
| Tag | `content-vX.Y.Z` (ej. `content-v0.1.0`) |
| Asset | `<id>-content.zip` (`dailygold-content.zip`) |
| Checksums | `SHA256SUMS` o `SHA256SUMS-<id>.txt` en el mismo Release |
| Dentro del zip | `game.manifest.json` en la **raíz**, ROM, assets |
| Body del Release | Notas en castellano para el modal **Novedades** del launcher — ver [RELEASE_NOTES.md](RELEASE_NOTES.md) |

## Empaquetar desde este repo (dev)

```sh
scripts/package-content.sh games/dailygold
# → dist/content/dailygold-content-v0.1.0.zip + SHA256SUMS-dailygold.txt
```

Sube el zip al Release del repo dueño (`unaisdev/dailygold` / `amoi-builds/dailyred`), no al launcher, salvo fallback centralizado.

## Orden si cambia el protocolo ROM

1. Adapter nuevo en `runner/protocols/` + Release del **launcher**.
2. Content pack con el nuevo `protocolId` y `compat.minLauncherVersion`.
3. Nunca al revés (el menú bloqueará packs cuyo adapter no exista).

Ver [PROTOCOL.md](PROTOCOL.md).
