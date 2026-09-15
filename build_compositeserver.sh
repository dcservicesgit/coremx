#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CENTRAL_DIR="${CENTRAL_DIR:-$ROOT_DIR/../central}"
PORTAL_OUTPUT="$ROOT_DIR/composite_portal"
SERVER_OUTPUT="$ROOT_DIR/composite_server"
case "$(uname -m)" in
    aarch64|arm64) DEFAULT_CENTRALFW_BINARY=centralfw-aarch64-unknown-linux-musl ;;
    *) DEFAULT_CENTRALFW_BINARY=centralfw-x86_64-unknown-linux-musl ;;
esac
CENTRALFW_BINARY="${CENTRALFW_BINARY:-$DEFAULT_CENTRALFW_BINARY}"
COREMX_WEBSOCKET_ENDPOINT="${COREMX_WEBSOCKET_ENDPOINT:-}"
INSTALL_PORTAL_DEPENDENCIES=true

usage() {
    cat <<'EOF'
Usage: ./build_compositeserver.sh [--no-install]

Compose the current Central portal/server with the CoreMX overlay.

Options:
  --no-install  Do not run npm ci in composite_portal (used by deploy.sh).
  -h, --help    Show this help.

Environment:
  CENTRAL_DIR       Central checkout (default: ../central).
  CENTRALFW_BINARY  Production CentralFW binary to include
                    (default: Linux musl binary for the host architecture).
  COREMX_WEBSOCKET_ENDPOINT
                    Portal API endpoint (default: same-origin /ws).
EOF
}

fail() {
    printf 'build_compositeserver: %s\n' "$*" >&2
    exit 1
}

while (($#)); do
    case "$1" in
        --no-install)
            INSTALL_PORTAL_DEPENDENCIES=false
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            usage >&2
            fail "unknown argument: $1"
            ;;
    esac
    shift
done

command -v rsync >/dev/null 2>&1 || fail "rsync is required"
[[ -d "$CENTRAL_DIR/portal" ]] || fail "Central portal not found: $CENTRAL_DIR/portal"
[[ -d "$CENTRAL_DIR/server" ]] || fail "Central server not found: $CENTRAL_DIR/server"
[[ -d "$ROOT_DIR/portal" ]] || fail "CoreMX portal overlay not found: $ROOT_DIR/portal"
[[ -d "$ROOT_DIR/server" ]] || fail "CoreMX server overlay not found: $ROOT_DIR/server"

command -v node >/dev/null 2>&1 || fail "node is required"
command -v realpath >/dev/null 2>&1 || fail "realpath is required"
[[ "$CENTRALFW_BINARY" =~ ^centralfw-[a-zA-Z0-9_-]+$ ]] || fail "CENTRALFW_BINARY must be a CentralFW release basename"
BINARY_SOURCE="$CENTRAL_DIR/releases/$CENTRALFW_BINARY"
[[ -x "$BINARY_SOURCE" ]] || fail "CentralFW binary missing or not executable: $BINARY_SOURCE"
# A build-produced checksum manifest avoids accidentally starting an older
# CentralFW executable that does not understand --capabilities.
CAPABILITIES_FILE="$BINARY_SOURCE.capabilities.json"
[[ -f "$CAPABILITIES_FILE" ]] || fail "CentralFW capability manifest missing; rebuild CentralFW in Central"
node "$ROOT_DIR/scripts/check-centralfw.js" "$BINARY_SOURCE" "$CAPABILITIES_FILE"
[[ -f "$CENTRAL_DIR/server/modules/applicationProfile.js" ]] || fail "Central application profiles are required"
[[ -f "$CENTRAL_DIR/server/modules/httpWorker.js" ]] || fail "Central HTTP workers are required"
for source in "$CENTRAL_DIR/portal" "$CENTRAL_DIR/server" "$ROOT_DIR/portal" "$ROOT_DIR/server"; do
    [[ -z "$(find "$source" -path '*/node_modules' -prune -o -path '*/.git' -prune -o -type l -print -quit)" ]] || fail "symlink found in source: $source"
done

ROOT_REAL="$(realpath "$ROOT_DIR")"
for output in "$PORTAL_OUTPUT" "$SERVER_OUTPUT"; do
    output_real="$(realpath -m "$output")"
    case "$output_real" in
        "$ROOT_REAL"/*) ;;
        *) fail "refusing to write outside the CoreMX checkout: $output_real" ;;
    esac
    [[ ! -L "$output" ]] || fail "refusing to replace symlinked output: $output"
    mkdir -p "$output"
done

# These are never part of a source composition. --delete-excluded also removes
# leftovers created by the old cp-based composer, including hidden .git trees.
COMMON_EXCLUDES=(
    --exclude='.agents/'
    --exclude='.cache/'
    --exclude='.codex/'
    --exclude='.data/'
    --exclude='.git/'
    --exclude='.github/'
    --exclude='.nitro/'
    --exclude='.nuxt/'
    --exclude='.output/'
    --exclude='coverage/'
    --exclude='dist'
    --exclude='logs/'
    --exclude='node_modules/'
    --exclude='.DS_Store'
    --exclude='.env'
    --exclude='.env.*'
    --exclude='*.bak'
    --exclude='*.log'
    --exclude='*.spec.js'
    --exclude='*.spec.ts'
    --exclude='*.swp'
    --exclude='*.test.js'
    --exclude='*.test.mjs'
    --exclude='*.test.ts'
    --exclude='*.tmp'
    --exclude='*.zip'
    --exclude='*.key'
    --exclude='*.pem'
    --exclude='*.p12'
    --exclude='*.pfx'
)

PORTAL_EXCLUDES=(
    --exclude='/LegacyPages/'
    --exclude='/README.md'
    --exclude='/components/E2EEUnlock_Original.vue'
    --exclude='/pages/__old_cloudops/'
    --exclude='/public/build.html'
    --exclude='/public/build.json'
    --exclude='/pnpm-lock.yaml'
    --exclude='/yarn.lock'
)

# CoreMX is a singleton application. Keep runtime source and dependencies,
# but omit Central development, migration, multi-host and generated artefacts.
# Feature modules under services/ remain because current Central core imports
# some of them transitively even when the CoreMX menu does not expose them.
SERVER_EXCLUDES=(
    --exclude='/README.md'
    --exclude='/a.json'
    --exclude='/config.json'
    --exclude='/darksys/'
    --exclude='/docs/'
    --exclude='/email-debug.html'
    --exclude='/executer/'
    --exclude='/isolatedcontextmgr/'
    --exclude='/init/exampleconfiguration.json'
    --exclude='/releases/'
    --exclude='/runtimebins/'
    --exclude='/scripts/'
    --exclude='/successful_purchases.json'
    --exclude='/sysdirector/'
    --exclude='/test/'
    --exclude='/test.js'
    --exclude='/database/memredis copy.js'
)

compose_tree() {
    local base_dir="$1"
    local overlay_dir="$2"
    local output_dir="$3"
    shift 3
    local -a tree_excludes=("$@")

    rsync -a --delete --delete-excluded \
        "${COMMON_EXCLUDES[@]}" "${tree_excludes[@]}" \
        "$base_dir/" "$output_dir/"

    # Overlay files win. A second mirror deletion is deliberately not used:
    # the overlay is sparse and must not remove files inherited from Central.
    rsync -a \
        "${COMMON_EXCLUDES[@]}" "${tree_excludes[@]}" \
        "$overlay_dir/" "$output_dir/"
}

printf 'Composing portal from %s with CoreMX overrides...\n' "$CENTRAL_DIR/portal"
compose_tree "$CENTRAL_DIR/portal" "$ROOT_DIR/portal" "$PORTAL_OUTPUT" "${PORTAL_EXCLUDES[@]}"

# Tests are excluded from this production composition, so remove Central's
# test-only command/dependency while preserving every other current dependency.
# Also retain the current Central socket client and change only its endpoint.
command -v node >/dev/null 2>&1 || fail "node is required to prepare the portal manifest"
node - \
    "$PORTAL_OUTPUT/package.json" \
    "$PORTAL_OUTPUT/package-lock.json" \
    "$PORTAL_OUTPUT/plugins/dcsajaxv3.js" \
    "$COREMX_WEBSOCKET_ENDPOINT" <<'NODE'
const fs = require('fs')

const [packageFilename, lockFilename, socketPluginFilename, websocketEndpoint] = process.argv.slice(2)
if (websocketEndpoint && new URL(websocketEndpoint).protocol !== 'wss:') throw new Error('CoreMX websocket overrides must use wss://')

for (const filename of [packageFilename, lockFilename]) {
    const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'))
    const root = filename.endsWith('package-lock.json') ? manifest.packages?.[''] : manifest

    if (root?.scripts) delete root.scripts.test
    if (root?.devDependencies) delete root.devDependencies.vitest

    fs.writeFileSync(filename, `${JSON.stringify(manifest, null, 2)}\n`)
}

let socketPlugin = fs.readFileSync(socketPluginFilename, 'utf8')
const endpointBlock = /  const WEBSOCKET_ENDPOINTS = \[[\s\S]*?\n  \];/
const endpointMatches = socketPlugin.match(new RegExp(endpointBlock.source, 'g')) || []
if (endpointMatches.length !== 1) {
    throw new Error(`expected one WEBSOCKET_ENDPOINTS block in ${socketPluginFilename}`)
}
socketPlugin = socketPlugin.replace(
    endpointBlock,
    `  const WEBSOCKET_ENDPOINTS = [\n    ${websocketEndpoint ? JSON.stringify(websocketEndpoint) : "((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws')"},\n  ];`
)
fs.writeFileSync(socketPluginFilename, socketPlugin)
NODE

printf 'Composing server from %s with CoreMX overrides...\n' "$CENTRAL_DIR/server"
compose_tree "$CENTRAL_DIR/server" "$ROOT_DIR/server" "$SERVER_OUTPUT" "${SERVER_EXCLUDES[@]}"

# Runtime selection is inherited from Central's applicationProfile hook.
[[ -f "$SERVER_OUTPUT/modules/applicationProfile.js" ]] || fail "Central application profiles are required"
[[ -f "$SERVER_OUTPUT/modules/httpWorker.js" ]] || fail "Central HTTP workers are required"

# Include only the production server binary, at the location main.js checks
# first. Apple/ARM builds and downloadable client runtime bins are not shipped.
BINARY_SOURCE="$CENTRAL_DIR/releases/$CENTRALFW_BINARY"
[[ -f "$BINARY_SOURCE" ]] || fail "CentralFW binary not found: $BINARY_SOURCE"
rsync -a "$BINARY_SOURCE" "$SERVER_OUTPUT/$CENTRALFW_BINARY"
chmod +x "$SERVER_OUTPUT/$CENTRALFW_BINARY"

find_forbidden_entry() {
    find "$1" \
        \( -type d \( -name .git -o -name .nuxt -o -name .output -o -name node_modules \) \
        -o -type f \( -name '.env' -o -name '.env.*' -o -name '*.log' \) \) \
        -print -quit
}

for output in "$PORTAL_OUTPUT" "$SERVER_OUTPUT"; do
    forbidden_entry="$(find_forbidden_entry "$output")"
    [[ -z "$forbidden_entry" ]] || fail "forbidden composition entry found: $forbidden_entry"
    unsafe_link="$(find "$output" -type l -print -quit)"
    [[ -z "$unsafe_link" ]] || fail "symlinks are not allowed in the composition: $unsafe_link"
done
[[ ! -e "$SERVER_OUTPUT/config.json" ]] || fail "server/config.json must not enter a Git composition"

if [[ "$INSTALL_PORTAL_DEPENDENCIES" == true ]]; then
    command -v npm >/dev/null 2>&1 || fail "npm is required (or use --no-install)"
    printf 'Installing portal dependencies with npm ci...\n'
    npm ci --prefix "$PORTAL_OUTPUT"
fi

central_revision="$(git -C "$CENTRAL_DIR" rev-parse HEAD)"
overlay_revision="$(git -C "$ROOT_DIR" rev-parse HEAD)"
central_dirty=false
[[ -z "$(git -C "$CENTRAL_DIR" status --porcelain)" ]] || central_dirty=true
overlay_dirty=false
[[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ]] || overlay_dirty=true
node "$ROOT_DIR/scripts/write-provenance.js" "$BINARY_SOURCE" "$SERVER_OUTPUT/composition.json" "$central_revision" "$central_dirty" "$overlay_revision" "$overlay_dirty"

printf 'Composition complete (CoreMX %s + Central %s).\n' "$overlay_revision" "$central_revision"
printf '  portal: %s\n  server: %s\n' "$PORTAL_OUTPUT" "$SERVER_OUTPUT"
