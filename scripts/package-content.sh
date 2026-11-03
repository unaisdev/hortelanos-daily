#!/usr/bin/env bash
# Empaqueta un game pack para GitHub Releases.
# Uso: scripts/package-content.sh games/dailygold
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACK_REL="${1:?pack path e.g. games/dailygold}"
PACK="$ROOT/$PACK_REL"
ID=$(python3 -c "import json; print(json.load(open('$PACK/game.manifest.json'))['id'])")
VER=$(python3 -c "import json; print(json.load(open('$PACK/game.manifest.json'))['contentVersion'])")
OUT_DIR="$ROOT/dist/content"
mkdir -p "$OUT_DIR"
"$ROOT/scripts/verify-protocol.sh" "$PACK_REL"
ZIP="$OUT_DIR/${ID}-content-v${VER}.zip"
rm -f "$ZIP"
( cd "$PACK" && zip -r "$ZIP" . -x '*.DS_Store' )
( cd "$OUT_DIR" && shasum -a 256 "$(basename "$ZIP")" > SHA256SUMS-${ID}.txt )
echo "Wrote $ZIP"
