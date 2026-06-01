#!/usr/bin/env python3
"""
Build dune/uploads/circles_profile_names.csv: every Circles avatar -> display name.

Sources (all from the public Circles infra, no auth):
  1. circles_query on V_CrcV2.Avatars (rpc.aboutcircles.com) — lists ALL avatars
     with their address, type, on-chain `name` (set only for groups/orgs), and
     `cidV0Digest` (points to the off-chain profile holding a human's name).
  2. profiles/getBatch?cids=... — resolves many profile CIDs to {address, name}
     in one request (the display name humans set in their Circles profile).

Final name precedence: resolved profile name, else on-chain name. Rows with no
name at all are dropped.

The CSV feeds the Dune uploaded table `dune.<handle>.dataset_word_circles_player_names`
(column `player` is 0x-hex, which Dune infers as varbinary so it joins directly
against on-chain player addresses). Upload with the Dune API
(POST /api/v1/uploads/csv) or the web UI (Upload Data).

Usage:
  python3 dune/scripts/build_circles_names.py
"""
import csv, json, os, sys, time, urllib.request, urllib.error

RPC = os.environ.get("CIRCLES_RPC", "https://rpc.aboutcircles.com/")
OUT = os.path.join(os.path.dirname(__file__), "..", "uploads", "circles_profile_names.csv")
PAGE = 10000          # circles_query server-side max
BATCH = 50            # CIDs per getBatch request (server caps at 50)
MAX_PASSES = 6        # retry passes over CIDs that transiently fail to resolve
_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def _post(body, timeout=120):
    req = urllib.request.Request(RPC, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def b58(b):
    n = int.from_bytes(b, "big"); out = ""
    while n > 0:
        n, r = divmod(n, 58); out = _B58[r] + out
    for byte in b:
        if byte == 0: out = "1" + out
        else: break
    return out


def cid_from_digest(hexd):
    h = hexd[2:] if hexd.startswith("0x") else hexd
    return b58(b"\x12\x20" + bytes.fromhex(h))  # 0x12 sha2-256, 0x20 len 32


def fetch_avatars():
    """Page through every avatar via circles_query (blockNumber cursor)."""
    seen = {}
    cursor, pages = 0, 0
    while True:
        d = _post({"jsonrpc": "2.0", "id": 1, "method": "circles_query", "params": [{
            "Namespace": "V_CrcV2", "Table": "Avatars",
            "Columns": ["blockNumber", "avatar", "type", "name", "cidV0Digest"],
            "Filter": [{"Type": "FilterPredicate", "FilterType": "GreaterThanOrEquals",
                        "Column": "blockNumber", "Value": cursor}],
            "Order": [{"Column": "blockNumber", "SortOrder": "ASC"}], "Limit": PAGE}]})
        rows, cols = d["result"]["rows"], d["result"]["columns"]
        bi, ai = cols.index("blockNumber"), cols.index("avatar")
        for r in rows:
            seen[r[ai]] = r
        pages += 1
        print(f"  avatars page {pages}: +{len(rows)} (uniq {len(seen)})", file=sys.stderr)
        if len(rows) < PAGE:
            return cols, list(seen.values())
        last = rows[-1][bi]
        cursor = last + 1 if last == cursor else last


def get_batch(cids, retries=3):
    url = RPC.rstrip("/") + "/profiles/getBatch?cids=" + ",".join(cids)
    for attempt in range(retries):
        try:
            return json.loads(urllib.request.urlopen(url, timeout=90).read())
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                print(f"  getBatch failed ({e}); skipping {len(cids)} cids", file=sys.stderr)
                return []
            time.sleep(2 * (attempt + 1))
    return []


def main():
    cols, rows = fetch_avatars()
    ni, ci, ai = cols.index("name"), cols.index("cidV0Digest"), cols.index("avatar")
    print(f"total avatars: {len(rows)}", file=sys.stderr)

    names = {}  # lowercase address -> name
    # 1) on-chain names (groups/orgs) as a baseline
    for r in rows:
        if r[ni]:
            names[r[ai].lower()] = r[ni]

    # 2) resolve profile (human) names via getBatch, overriding the baseline.
    # getBatch returns null for a CID whenever the IPFS fetch transiently fails,
    # so retry the still-unresolved CIDs over several passes until it converges
    # (observed recovery on retry is ~98%).
    pending = [cid_from_digest(r[ci]) for r in rows if r[ci]]
    for p in range(1, MAX_PASSES + 1):
        still = []
        for i in range(0, len(pending), BATCH):
            chunk = pending[i:i + BATCH]
            got = {}
            for prof in get_batch(chunk):
                if prof and prof.get("CID") and prof.get("name") and prof.get("address"):
                    names[prof["address"].lower()] = prof["name"]
                    got[prof["CID"]] = True
            still.extend(c for c in chunk if c not in got)
            time.sleep(0.05)
        print(f"pass {p}: named {len(names)}, still unresolved {len(still)}", file=sys.stderr)
        if not still or len(still) == len(pending):
            pending = still
            break
        pending = still
    print(f"final named: {len(names)} (unresolved CIDs left: {len(pending)})", file=sys.stderr)

    # 3) write CSV (sanitize names: strip control chars / newlines; csv handles quoting)
    def clean(s):
        return "".join(c for c in s if c == " " or c.isprintable()).strip()

    out = os.path.normpath(OUT)
    with open(out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["player", "name"])
        for addr in sorted(names):
            nm = clean(names[addr])
            if nm:
                w.writerow([addr, nm])
    print(f"wrote {out}: {sum(1 for _ in open(out)) - 1} named avatars", file=sys.stderr)


if __name__ == "__main__":
    main()
