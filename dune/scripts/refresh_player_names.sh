#!/usr/bin/env bash
#
# Refresh dune/uploads/player_names.csv  (address -> Circles profile name).
#
# Why this exists:
#   The leaderboard query (dune/queries/03_global_leaderboard_streaks.sql) used
#   to resolve names live with one http_post to rpc.aboutcircles.com per player,
#   which trips Dune's per-execution HTTP request cap ("too many HTTP requests").
#   Instead we resolve names OFFLINE here (no cap) and upload the result as a
#   static Dune table the query reads from.
#
# Player list source (first that yields rows wins):
#   1. Addresses given as args, or piped on stdin (one 0x-address per line).
#   2. Dune query PLAYERS_QUERY_ID, fetched via the API (needs DUNE_API_KEY).
#
# Usage:
#   ./dune/scripts/refresh_player_names.sh                 # uses Dune API
#   DUNE_API_KEY=xxx ./dune/scripts/refresh_player_names.sh
#   ./dune/scripts/refresh_player_names.sh 0xabc... 0xdef...
#   cat addrs.txt | ./dune/scripts/refresh_player_names.sh
#
# After it runs, upload the CSV to Dune:
#   Dune -> Upload Data -> select dune/uploads/player_names.csv
#   -> name the dataset EXACTLY  word_circles_player_names
#   (resolves to dune.<handle>.dataset_word_circles_player_names)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$REPO_ROOT/dune/uploads/player_names.csv"

# Saved Dune query returning a single `player` column of lowercase 0x addresses.
PLAYERS_QUERY_ID="${PLAYERS_QUERY_ID:-7620997}"
CIRCLES_RPC="${CIRCLES_RPC:-https://rpc.aboutcircles.com/}"

# --- 1. Gather the player address list -------------------------------------
addrs=()
if [[ $# -gt 0 ]]; then
  addrs=("$@")
elif [[ ! -t 0 ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && addrs+=("$line")
  done
fi

if [[ ${#addrs[@]} -eq 0 ]]; then
  if [[ -z "${DUNE_API_KEY:-}" ]]; then
    echo "error: no addresses given and DUNE_API_KEY is not set." >&2
    echo "       pass addresses as args, pipe them on stdin, or export DUNE_API_KEY." >&2
    exit 1
  fi
  echo "Fetching player list from Dune query $PLAYERS_QUERY_ID ..." >&2
  # Trigger a fresh execution, then poll until it completes.
  exec_id=$(curl -s -X POST \
    "https://api.dune.com/api/v1/query/$PLAYERS_QUERY_ID/execute" \
    -H "X-DUNE-API-KEY: $DUNE_API_KEY" \
    -H 'Content-Type: application/json' \
    -d '{"performance":"medium"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['execution_id'])")
  for _ in $(seq 1 60); do
    state=$(curl -s "https://api.dune.com/api/v1/execution/$exec_id/status" \
      -H "X-DUNE-API-KEY: $DUNE_API_KEY" \
      | python3 -c "import sys,json;print(json.load(sys.stdin)['state'])")
    [[ "$state" == "QUERY_STATE_COMPLETED" ]] && break
    if [[ "$state" == QUERY_STATE_FAILED || "$state" == QUERY_STATE_CANCELLED ]]; then
      echo "error: Dune execution $exec_id ended in $state" >&2; exit 1
    fi
    sleep 2
  done
  while IFS= read -r line; do
    [[ -n "$line" ]] && addrs+=("$line")
  done < <(curl -s "https://api.dune.com/api/v1/execution/$exec_id/results" \
    -H "X-DUNE-API-KEY: $DUNE_API_KEY" \
    | python3 -c "import sys,json;[print(r['player']) for r in json.load(sys.stdin)['result']['rows']]")
fi

if [[ ${#addrs[@]} -eq 0 ]]; then
  echo "error: resolved 0 player addresses." >&2; exit 1
fi
echo "Resolving Circles names for ${#addrs[@]} players ..." >&2

# --- 2. Resolve each name from the Circles RPC (no per-call cap here) -------
tmp="$(mktemp)"
printf 'player,name\n' > "$tmp"
for a in "${addrs[@]}"; do
  la="$(echo "$a" | tr '[:upper:]' '[:lower:]')"
  resp=$(curl -s --max-time 15 -X POST "$CIRCLES_RPC" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"circles_getProfileByAddress\",\"params\":[\"$la\"]}")
  name=$(printf '%s' "$resp" | python3 -c "import sys,json
d=json.load(sys.stdin); r=d.get('result') or {}
print((r.get('name') or '').replace('\n',' ').replace(',',' ').strip())" 2>/dev/null || true)
  printf '%s,%s\n' "$la" "$name" >> "$tmp"
  printf '  %-44s -> %s\n' "$la" "$name" >&2
done

mv "$tmp" "$OUT"
echo "Wrote $OUT (${#addrs[@]} rows). Now upload it to Dune as 'word_circles_player_names'." >&2
