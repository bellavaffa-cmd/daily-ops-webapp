#!/usr/bin/env python3
"""
sync_ops.py — Sync B2C fulfillment data from Logiwa (wms.golocad.com) to Supabase.

Data source: Logiwa WMS API (mywmsquery.logiwa.com)
Auth: Bearer token from your Logiwa browser session (LOGIWA_TOKEN env var)

Usage:
  python3 sync_ops.py          # sync B2C
  python3 sync_ops.py --dry    # print results without writing to Supabase

Setup:
  1. Open wms.golocad.com in Chrome
  2. Cmd+Option+I → Application → Local Storage → wms.golocad.com
  3. Copy value of the key "token"
  4. export LOGIWA_TOKEN=<paste here>
  5. python3 sync_ops.py

Schedule with cron:
  LOGIWA_TOKEN=xxx 0 * * * * python3 /path/to/sync_ops.py
"""

import os
import sys
import requests
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
LOGIWA_TOKEN = os.environ.get("LOGIWA_TOKEN", "")
LOGIWA_API   = "https://mywmsquery.logiwa.com"

SUPABASE_URL = "https://hmpkjmnxoidesnnoecfm.supabase.co"
SUPABASE_KEY = "sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP"

# ── Logiwa status ID → B2C dashboard column ───────────────────────────────────
# Discovered from: mywmsquery.logiwa.com/api/type/shipmentorderstatustype/for/filter
B2C_STATUS_MAP = {
    6:  "new",      # Open
    8:  "rfp",      # Ready to Pick
    9:  "picking",  # Picking Started
    12: "picked",   # Ready to Pack (items picked, awaiting packing)
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def now_iso():
    return datetime.now(timezone.utc).isoformat()


def logiwa_headers():
    if not LOGIWA_TOKEN:
        print("ERROR: LOGIWA_TOKEN is not set.")
        print("  1. Open wms.golocad.com in Chrome")
        print("  2. Cmd+Option+I → Application → Local Storage → wms.golocad.com")
        print("  3. Copy value of the key 'token'")
        print("  4. export LOGIWA_TOKEN=<paste here>")
        sys.exit(1)
    return {
        "Authorization": f"Bearer {LOGIWA_TOKEN}",
        "Content-Type":  "application/json",
    }


def sb_headers():
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }


def fetch_all_orders():
    """Fetch all unshipped orders from Logiwa with pagination."""
    headers = logiwa_headers()
    page_size = 1000
    all_orders = []
    page = 0

    while True:
        url = f"{LOGIWA_API}/api/shipmentorder/list/unshipped/i/{page}/s/{page_size}"
        res = requests.post(url, headers=headers, json={}, timeout=60)
        res.raise_for_status()
        d = res.json()
        batch = d.get("data", [])
        all_orders.extend(batch)
        total = d.get("totalCount", 0)
        print(f"  Fetched {len(all_orders)}/{total} orders (page {page})")
        if len(all_orders) >= total:
            break
        page += 1

    return all_orders


def pivot_b2c(orders):
    """Group orders by warehouseCode and count by status."""
    zero = {col: 0 for col in set(B2C_STATUS_MAP.values())}
    warehouses = {}
    for o in orders:
        if o.get("shipmentOrderTypeName") != "B2C":
            continue
        wh     = o.get("warehouseCode")
        status = o.get("shipmentOrderStatusId")
        col    = B2C_STATUS_MAP.get(status)
        if not wh or col is None:
            continue
        if wh not in warehouses:
            warehouses[wh] = {"wh": wh, **zero}
        warehouses[wh][col] += 1
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
    print(f"  ✓ Upserted {len(payload)} warehouses to {table}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    dry = "--dry" in sys.argv

    if dry:
        print("=== DRY RUN — no data will be written to Supabase ===")

    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Fetching orders from Logiwa…")
    orders = fetch_all_orders()
    print(f"  Total: {len(orders)} unshipped orders")

    rows = pivot_b2c(orders)
    print(f"\n  Pivoted to {len(rows)} warehouse(s):")
    for r in rows:
        print(f"    {r['wh']}: new={r['new']} rfp={r['rfp']} picking={r['picking']} picked={r['picked']}")

    print()
    upsert("b2c_data", rows, dry)

    print("\n✅ Done. Open the app and press Refresh to see updated data.")


if __name__ == "__main__":
    main()
