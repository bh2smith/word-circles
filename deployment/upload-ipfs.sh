#!/usr/bin/env bash
#
# Upload a DAppNode package RELEASE DIRECTORY to IPFS and record the hash in
# releases.json. Replaces `dappnodesdk from_github` (which expects a full
# SDK-format release we don't publish as separate GitHub assets).
#
# IMPORTANT: DAppNode installs from a *directory* CID, not a lone .txz. The
# directory must contain the four files dappnodesdk produces:
#   dappnode_package.json, docker-compose.yml, avatar.png, <name>_<ver>_linux-amd64.txz
# (verified against the published v0.6.1 release listing). Uploading just the
# .txz yields a hash that fails to install with "Invalid DNP name, must be a ENS
# domain" because the manifest isn't reachable under it.
#
# Usage:
#   VERSION=0.6.2 ./upload-ipfs.sh                  # use the local build_<name>_<ver>/ dir
#   VERSION=0.6.2 DIR=path/to/release/dir ./upload-ipfs.sh
#
# Env:
#   VERSION   (required) package version, e.g. 0.6.2 (no leading "v")
#   IPFS_API  IPFS API base (default: http://ipfs.dappnode:5001 — needs VPN to the dappnode)
#   DIR       optional release dir; defaults to deployment/build_<name>_<version>/
set -euo pipefail

# Resolve an explicit DIR against the caller's cwd before we chdir, so both
# `make release-ipfs DIR=deployment/build_...` (from repo root) and a bare
# relative DIR work.
if [ -n "${DIR:-}" ]; then DIR="$(cd "$DIR" && pwd)"; fi

cd "$(dirname "$0")" # deployment/

: "${VERSION:?set VERSION, e.g. VERSION=0.6.2}"
IPFS_API="${IPFS_API:-http://ipfs.dappnode:5001}"
NAME="$(node -p "require('./dappnode_package.json').name")"
DIR="${DIR:-build_${NAME}_${VERSION}}"
TXZ="${NAME}_${VERSION}_linux-amd64.txz"
RELEASES="releases.json"

# 1. Validate the release directory has the four files DAppNode expects.
[ -d "$DIR" ] || { echo "error: release dir not found: $DIR (run 'dappnodesdk build' or download the .txz into it)" >&2; exit 1; }
for f in dappnode_package.json docker-compose.yml avatar.png "$TXZ"; do
  [ -f "$DIR/$f" ] || { echo "error: $DIR is missing required file: $f" >&2; exit 1; }
done
echo "Uploading release dir $DIR ($(du -sh "$DIR" | cut -f1)) to ${IPFS_API}..."

# 2. Add the four files wrapped in a directory (CIDv0 to match prior releases,
#    pinned). Each file is sent with a bare filename so the wrapping directory
#    contains them flat (no nested build_* path), matching the published layout.
RESP="$(curl -sf -X POST "${IPFS_API}/api/v0/add?pin=true&cid-version=0&recursive=true&wrap-with-directory=true" \
  -F "file=@${DIR}/dappnode_package.json;filename=dappnode_package.json" \
  -F "file=@${DIR}/docker-compose.yml;filename=docker-compose.yml" \
  -F "file=@${DIR}/avatar.png;filename=avatar.png" \
  -F "file=@${DIR}/${TXZ};filename=${TXZ}")"

# add returns one JSON object per line; the wrapping directory is the entry with
# an empty Name. That root CID is what DAppNode installs from (it lists the four
# files). Uploading the .txz alone instead yields "Invalid DNP name" on install.
HASH="$(node -e '
  const resp = process.argv[1];
  const rows = resp.trim().split("\n").map(l => JSON.parse(l));
  const root = rows.find(r => r.Name === "");
  if (!root) { console.error("no wrapping-directory entry in:\n" + resp); process.exit(1); }
  process.stdout.write(root.Hash);
' "$RESP")"
[ -n "$HASH" ] || { echo "error: could not parse directory CID from IPFS response:" >&2; echo "$RESP" >&2; exit 1; }
echo "Pinned release directory: /ipfs/${HASH}"
echo "  Verify:  ${IPFS_API%:*}:8080/ipfs/${HASH}  (should list the 4 files)"
# The DAppNode installer takes the URL-encoded /ipfs/<hash> path (%2F = /).
echo "  Install: ${DAPPNODE_URL:-http://my.dappnode}/installer/public/%2Fipfs%2F${HASH}"

# 3. Record it in releases.json (idempotent: overwrites the entry for VERSION).
node -e '
  const fs = require("fs");
  const [file, version, hash] = process.argv.slice(1);
  const r = JSON.parse(fs.readFileSync(file, "utf8"));
  r[version] = {
    hash: "/ipfs/" + hash,
    uploadedTo: { dappnode: new Date().toUTCString() },
  };
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
' "$RELEASES" "$VERSION" "$HASH"
echo "Recorded ${VERSION} in deployment/${RELEASES}. Review and commit it."
