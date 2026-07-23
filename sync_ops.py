#!/usr/bin/env python3
"""
sync_ops.py — Sync B2C and B2B fulfillment data from Metabase to Supabase.

Queries Metabase directly via MBQL (no dashboard card scanning needed).

Usage:
  python3 sync_ops.py          # sync both B2C and B2B
  python3 sync_ops.py --b2c    # B2C only
  python3 sync_ops.py --b2b    # B2B only
  python3 sync_ops.py --dry    # print results without writing to Supabase

Schedule with cron:  0 * * * * python3 /path/to/sync_ops.py
"""

import requests
import sys
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
METABASE_URL     = "https://metabase.golocad.com"
METABASE_API_KEY = ""          # Paste your API key here

SUPABASE_URL = "https://hmpkjmnxoidesnnoecfm.supabase.co"
SUPABASE_KEY = "sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP"

# ── Metabase field IDs (discovered via API — do not change) ───────────────────
# fct_warehouse_performance (table 27) — B2C
B2C_TABLE          = 27
B2C_FIELD_WAREHOUSE = 539   # "warehouse"
B2C_FIELD_STATUS    = 524   # "fulfilment_status"

# fct_outbound_bulk_orders (table 28) — B2B
B2B_TABLE              = 28
B2B_FIELD_WAREHOUSE    = 558   # "warehouse_name"
B2B_FIELD_STATUS       = 567   # "consignment_status"

DATABASE_ID = 2

# ── Status mappings ───────────────────────────────────────────────────────────
# B2C: fulfilment_status → Supabase column
B2C_STATUS_MAP = {
    "NEW":               "new",      # Open — just arrived, not yet in picking
    "RELEASED":          "new",      # Released to warehouse floor (still Open)
    "READY_FOR_PICKING": "rfp",      # Ready for Picking
    "PICKING":           "picking",  # Picking Started
    "PICKED":            "picked",   # Ready to Pack (items picked, awaiting packing)
}

# B2B: consignment_status → Supabase column
B2B_STATUS_MAP = {
    "CONFIRMED":         "open",       # Open (confirmed, not yet in picking)
    "READY_FOR_PICKING": "rfp",        # Ready to Pick
    "PICKING":           "picking",    # Picking Started
    "PICKED":            "pack_ready", # Ready to Pack
    "PACKING":           "packing",    # Packing Started
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def mb_headers():
    if not METABASE_API_KEY:
        print("ERROR: METABASE_API_KEY is not set. Edit sync_ops.py and add your API key.")
        sys.exit(1)
    return {"x-api-key": METABASE_API_KEY, "Content-Type": "application/json"}


def sb_headers():
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }


def run_mbql(table_id, warehouse_field_id, status_field_id, statuses):
    """Run a grouped MBQL query: count(*) GROUP BY warehouse, status WHERE status IN (...)"""
    query = {
        "database": DATABASE_ID,
        "type":     "query",
        "query": {
            "source-table": table_id,
            "aggregation":  [["count"]],
            "breakout": [
                ["field", warehouse_field_id, None],
                ["field", status_field_id,   None],
            ],
            "filter": ["=", ["field", status_field_id, None]] + list(statuses),
        }
    }
    url = f"{METABASE_URL}/api/dataset"
    res = requests.post(url, headers=mb_headers(), json=query, timeout=60)
    res.raise_for_status()
    d = res.json()
    if "error" in d:
        raise RuntimeError(f"Metabase query error: {d['error']}")
    cols = [c["name"] for c in d["data"]["cols"]]
    return [dict(zip(cols, row)) for row in d["data"]["rows"]]


def pivot_to_warehouses(rows, warehouse_col, status_col, status_map):
    """Group rows by warehouse and pivot status counts into columns."""
    zero_row = {col: 0 for col in set(status_map.values())}
    warehouses = {}
    for r in rows:
        wh     = r.get(warehouse_col)
        status = r.get(status_col)
        count  = r.get("count", 0) or 0
        if not wh:
            continue
        if wh not in warehouses:
            warehouses[wh] = {"wh": wh, **zero_row}
        mapped = status_map.get(status)
        if mapped:
            warehouses[wh][mapped] += count
    return list(warehouses.values())


def upsert(table, rows, dry_run=False):
    ts = now_iso()
    payload = [{**r, "updated_at": ts} for r in rows]
    if dry_run:
        print(f"  [dry] Would upsert {len(payload)} rows to {table}:")
        for r in payload:
            print(f"    {r}")
        return
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    res = requests.post(url, headers=sb_headers(), json=payload, timeout=30)
    if not res.ok:
        print(f"  Supabase error {res.status_code}: {res.text}")
        res.raise_for_status()
    print(f"  ✓ Upserted {len(payload)} rows to {table}")


# ── Sync functions ────────────────────────────────────────────────────────────
def sync_b2c(dry_run=False):
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Syncing B2C…")
    rows = run_mbql(
        B2C_TABLE, B2C_FIELD_WAREHOUSE, B2C_FIELD_STATUS,
        list(B2C_STATUS_MAP.keys())
    )
    print(f"  Metabase returned {len(rows)} rows")
    warehouses = pivot_to_warehouses(
        rows, "warehouse", "fulfilment_status", B2C_STATUS_MAP
    )
    print(f"  Pivoted to {len(warehouses)} warehouses")
    for w in warehouses:
        print(f"    {w['wh']}: new={w['new']} rfp={w['rfp']} picking={w['picking']} picked={w['picked']}")
    upsert("b2c_data", warehouses, dry_run)


def sync_b2b(dry_run=False):
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Syncing B2B…")
    rows = run_mbql(
        B2B_TABLE, B2B_FIELD_WAREHOUSE, B2B_FIELD_STATUS,
        list(B2B_STATUS_MAP.keys())
    )
    print(f"  Metabase returned {len(rows)} rows")
    warehouses = pivot_to_warehouses(
        rows, "warehouse_name", "consignment_status", B2B_STATUS_MAP
    )
    print(f"  Pivoted to {len(warehouses)} warehouses")
    for w in warehouses:
        print(f"    {w['wh']}: open={w['open']} rfp={w['rfp']} picking={w['picking']} pack_ready={w['pack_ready']} packing={w['packing']}")
    upsert("b2b_data", warehouses, dry_run)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    args = set(sys.argv[1:])
    dry  = "--dry" in args
    run_b2c = "--b2b" not in args
    run_b2b = "--b2c" not in args

    if dry:
        print("=== DRY RUN — no data will be written to Supabase ===")

    if run_b2c:
        sync_b2c(dry)
    if run_b2b:
        sync_b2b(dry)

    print("\n✅ Done. Open the app and press Refresh to see updated data.")


if __name__ == "__main__":
    main()
