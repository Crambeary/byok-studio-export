#!/usr/bin/env bash
# Validate the built plugin in the real Obsidian desktop app, jailed with bubblewrap.
# Usage: npm ci && experiments/obsidian_desktop/run.sh
# Needs: bwrap, the Arch `obsidian` package (Electron 43 + /usr/lib/obsidian/app.asar),
# /usr/bin/sqlite3, and permission to create user and network namespaces.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
electron=/usr/lib/electron43/electron
appasar=/usr/lib/obsidian/app.asar
for needed in bwrap "$electron" "$appasar" /usr/bin/sqlite3; do
  command -v "$needed" >/dev/null || { echo "missing prerequisite: $needed" >&2; exit 2; }
done

(cd "$repo" && npm run build >/dev/null)
work="$(mktemp -d "${TMPDIR:-/tmp}/byok-obsidian-XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/plugin" "$here/evidence"
cp "$repo/manifest.json" "$repo/main.js" "$work/plugin/"
cp "$repo/experiments/studio_writeback/evidence/schema.sql" "$work/schema.sql"

# Only metadata of the owner's live Obsidian config is compared; contents are never read.
live_config="${XDG_CONFIG_HOME:-$HOME/.config}/obsidian"
fingerprint_live() { stat -c '%Y %s' "$live_config/obsidian.json" 2>/dev/null || echo absent; }
live_before="$(fingerprint_live)"

status=0
# /home is an empty tmpfs: live vaults, keychains and credentials do not exist in here.
# --unshare-all includes the network namespace, leaving only an isolated loopback.
env -i bwrap --unshare-all --die-with-parent --new-session \
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib \
  --symlink usr/lib /lib64 --symlink usr/bin /sbin \
  --ro-bind /etc/fonts /etc/fonts --ro-bind /etc/ld.so.cache /etc/ld.so.cache \
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run --tmpfs /home \
  --bind "$work" /work --ro-bind "$here/driver.js" /harness/driver.js \
  --bind "$here/evidence" /out \
  --setenv PATH /usr/bin --setenv LANG en_US.UTF-8 \
  --setenv HOME /work/home --setenv XDG_CONFIG_HOME /work/cfg \
  --setenv XDG_CACHE_HOME /work/cache --setenv XDG_RUNTIME_DIR /work/run \
  --setenv TMPDIR /work/tmp --setenv ELECTRON_RUN_AS_NODE 1 \
  --setenv PLUGIN_SHA "$(sha256sum "$repo/main.js" | cut -d' ' -f1)" \
  --setenv SRC_TREE "$(git -C "$repo" rev-parse HEAD:src)" \
  --setenv BASE_COMMIT "$(git -C "$repo" rev-parse HEAD)" \
  "$electron" /harness/driver.js || status=$?

live_after="$(fingerprint_live)"
if [[ "$live_before" == "$live_after" ]]; then echo "live Obsidian config metadata unchanged"; else
  echo "LIVE OBSIDIAN CONFIG METADATA CHANGED DURING RUN (another process may have run Obsidian)" >&2; status=3; fi
exit "$status"
