#!/usr/bin/env bash
# Verifica que un pack declare protocol conocido y que la ROM contenga el magic de config.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK="${1:-games/dailygold}"
MANIFEST="$ROOT/$PACK/game.manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Missing manifest: $MANIFEST" >&2
  exit 1
fi

PROTOCOL=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['protocolId'])")
MAGIC=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['rom']['configMagic'])")
ROM_REL=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['rom']['path'])")
STATUS=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('status',''))")

ADAPTER="$ROOT/runner/protocols/${PROTOCOL}.js"
if [[ ! -f "$ADAPTER" ]]; then
  echo "No adapter for protocolId=$PROTOCOL at $ADAPTER" >&2
  exit 1
fi
echo "OK adapter $PROTOCOL"

if [[ "$STATUS" == "awaiting-content-pack" ]]; then
  echo "SKIP ROM check (awaiting-content-pack)"
  exit 0
fi

ROM="$ROOT/$PACK/$ROM_REL"
if [[ ! -f "$ROM" ]]; then
  echo "Missing ROM: $ROM" >&2
  exit 1
fi

python3 - "$ROM" "$MAGIC" <<'PY'
import gzip, sys
path, magic = sys.argv[1], sys.argv[2].encode()
raw = open(path, 'rb').read()
if raw[:2] == b'\x1f\x8b':
    raw = gzip.decompress(raw)
if magic not in raw:
    raise SystemExit(f'Magic {magic!r} not found in ROM')
print(f'OK magic {magic.decode()} in {path}')
PY
