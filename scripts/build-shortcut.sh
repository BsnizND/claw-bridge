#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${SIRI_BRIDGE_URL:-}" ]]; then
  echo "ERROR: set SIRI_BRIDGE_URL, for example https://example.com/shortcuts/message" >&2
  exit 1
fi

if [[ -z "${SIRI_BRIDGE_TOKEN:-}" ]]; then
  echo "ERROR: set SIRI_BRIDGE_TOKEN to the bridge bearer token" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHORTCUT_NAME="${SHORTCUT_NAME:-Tell Jay}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/shortcuts}"
SIGN_MODE="${SHORTCUT_SIGN_MODE:-contacts}"
CHERRI_VERSION="${CHERRI_VERSION:-v2.3.0}"
CHERRI_BIN="${CHERRI_BIN:-}"
SOURCE_TEMPLATE="${SOURCE_TEMPLATE:-$ROOT_DIR/examples/tell-jay.cherri.template}"

mkdir -p "$OUTPUT_DIR"

if [[ -z "$CHERRI_BIN" ]]; then
  case "$(uname -m)" in
    arm64) cherri_asset="cherri_darwin-arm64.zip" ;;
    x86_64) cherri_asset="cherri_darwin-x86_64.zip" ;;
    *)
      echo "ERROR: unsupported macOS architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac

  cherri_dir="$OUTPUT_DIR/.cherri-$CHERRI_VERSION"
  CHERRI_BIN="$cherri_dir/cherri"
  if [[ ! -x "$CHERRI_BIN" ]]; then
    mkdir -p "$cherri_dir"
    zip_path="$cherri_dir/cherri.zip"
    curl -fL \
      "https://github.com/electrikmilk/cherri/releases/download/$CHERRI_VERSION/$cherri_asset" \
      -o "$zip_path"
    unzip -q -o "$zip_path" -d "$cherri_dir"
    chmod +x "$CHERRI_BIN"
  fi
fi

source_path="$OUTPUT_DIR/$SHORTCUT_NAME.cherri"
shortcut_path="$OUTPUT_DIR/$SHORTCUT_NAME.shortcut"

SIRI_BRIDGE_URL="$SIRI_BRIDGE_URL" \
SIRI_BRIDGE_TOKEN="$SIRI_BRIDGE_TOKEN" \
SOURCE_TEMPLATE="$SOURCE_TEMPLATE" \
SOURCE_OUTPUT="$source_path" \
python3 - <<'PY'
import os
from pathlib import Path

template = Path(os.environ["SOURCE_TEMPLATE"]).read_text(encoding="utf-8")
url = os.environ["SIRI_BRIDGE_URL"].strip()
token = os.environ["SIRI_BRIDGE_TOKEN"].strip()

if not url.endswith("/shortcuts/message"):
    raise SystemExit("ERROR: SIRI_BRIDGE_URL should end with /shortcuts/message")

share_url = url.removesuffix("/shortcuts/message") + "/shortcuts/share"

rendered = (
    template
    .replace("__SIRI_BRIDGE_URL__", url.replace("\\", "\\\\").replace('"', '\\"'))
    .replace("__SIRI_BRIDGE_SHARE_URL__", share_url.replace("\\", "\\\\").replace('"', '\\"'))
    .replace("__SIRI_BRIDGE_TOKEN__", token.replace("\\", "\\\\").replace('"', '\\"'))
)

Path(os.environ["SOURCE_OUTPUT"]).write_text(rendered, encoding="utf-8")
PY

"$CHERRI_BIN" "$source_path" \
  --output="$shortcut_path" \
  --share="$SIGN_MODE" \
  --derive-uuids

echo "Wrote signed Shortcut: $shortcut_path"
echo "Wrote token-bearing Cherri source: $source_path"
echo "Do not commit files from $OUTPUT_DIR."
