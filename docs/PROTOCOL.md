# Protocolo ROM ↔ runner (Hortelano's Daily)

No es una API de red. Es el contrato binario entre la ROM parcheada (C en pret/pokefirered) y el JavaScript del runner.

## Identificador

`protocolId` actual: `dailyred-conf-v2+status-v1`

Cubre Daily Gold y Daily Red hoy (misma familia de magics).

## Bloques

### Config en ROM — `DAILYRED-CONF-V2`

Tras 16 bytes de magic, little-endian:

| Offset | Tipo | Campo |
|--------|------|--------|
| 0 | u32 | seed |
| 4 | u16 | wins |
| 6 | u16 | battles |
| 8 | u8 | daily (1 = un combate) |

El runner busca el magic y escribe estos campos **antes** de arrancar mGBA.

### Estado en RAM — `DAILYRED-STATUS1`

Tras 16 bytes de magic + u32 seed (debe coincidir con la seed de boot):

| Offset desde magic | Tipo | Campo |
|--------------------|------|--------|
| 20 | u8 | phase (0 explorar, 1 combate, 2 resultado, 3 fin) |
| 21 | u8 | result (0 none, 1 won, 2 lost) |

## Cómo bumpear el protocolo

1. Añadir adapter en `runner/protocols/<nuevo-id>.js` y registrarlo en `runner/protocols/index.js`.
2. Publicar **nuevo launcher** que incluya ese adapter.
3. Solo entonces publicar content packs con el nuevo `protocolId` y `minLauncherVersion`.
4. CI de content debe fallar si el adapter no existe en el último Release del launcher.

Nunca publiques un pack con magic nuevo sin launcher compatible.

## Verificación local

```sh
scripts/verify-protocol.sh games/dailygold
```
