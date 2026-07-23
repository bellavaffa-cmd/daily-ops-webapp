#!/usr/bin/env python3
"""
sync_ops.py — Sync B2C and B2B fulfillment data from Metabase to Supabase.

Usage:
  1. Fill in METABASE_API_KEY below.
  2. Run:  python3 sync_ops.py          # sync both B2C and B2B
           python3 sync_ops.py --b2c    # B2C only
           python3 sync_ops.py --b2b    # B2B only
           python3 sync_ops.py --list   # list all cards in each dashboard
  3. Schedule with cron:  0 * * * * python3 /path/to/sync_ops.py
"""

import requests
import sys
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
METABASE_URL     = "https://metabase.golocad.com"
METABASE_API_KEY = ""          # Paste your API key here

SUPABASE_URL = "https://hmpkjmnxoidesnnoecfm.supabase.co"
SUPABASE_KEY = "sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP"

B2C_DASHBOARD_ID = 479         # Daily Ops B2C dashboard
B2B_DASHBOARD_ID = 0           # Set to your B2B Metabase dashboard ID (run --list to find it)

# ── Column maps ───────────────────────────────────────────────────────────────
B2C_COL_MAP = {
    "warehouse":          "wh",
    "wh":                 "wh",
    "warehouse_name":     "wh",
    "new":                "new",
    "new_orders":         "new",
    "rfp":                "rfp",
    "ready_for_picking":  "rfp",
    "picking":            "picking",
    "in_picking":         "picking",
    "picked":             "picked",
    "total_picked":       "picked",
    "ready_to_pack":      "picked",   # B2C "Ready to Pack" = picked column
    "type":               "type",
    "country":            "country",
}

B2B_COL_MAP = {
    "warehouse":          "wh",
    "wh":                 "wh",
    "warehouse_name":     "wh",
    "open":               "open",
    "new":                "open",     # "Open" status in B2B
    "rfp":                "rfp",
    "ready_to_pick":      "rfp",
    "ready_for_picking":  "rfp",
    "picking":            "picking",
    "picking_started":    "picking",
    "in_picking":         "picking",
    "pack_ready":         "pack_ready",
    "ready_to_pack":      "pack_ready",
    "packing":            "packing",
    "packing_started":    "packing",
}

# ── HTTP helpers ──────────────────────────────────────────────────────────────
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


# ── Metabase helpers ──────────────────────────────────────────────────────────
def get_dashboard_cards(dashboard_id):
    url = f"{METABASE_URL}/api/dashboard/{dashboard_id}"
    res = requests.get(url, headers=mb_headers(), timeout=30)
    res.raise_for_status()
    return res.json().get("dashcards", [])


def execute_card(card_id):
    url = f"{METABASE_URL}/api/card/{card_id}/query/json"
    res = requests.post(url, headers=mb_headers(), timeout=60)
    res.raise_for_status()
    return res.json()


# ── Card detection ────────────────────────────────────────────────────────────
def _has_wh_and_metrics(rows, col_map, metric_keys):
    if not rows or not isinstance(rows[0], dict):
        return False
    keys = {k.lower().strip() for k in rows[0].keys()}
    has_wh     = any(k in col_map for k in keys)
    has_metric = any(k in metric_keys for k in keys)
    return has_wh and has_metric


def looks_like_b2c_card(rows):
    return _has_wh_and_metrics(rows, B2C_COL_MAP,
        {"new", "rfp", "picking", "picked", "new_orders",
         "ready_for_picking", "in_picking", "total_picked", "ready_to_pack"})


def looks_like_b2b_card(rows):
    return _has_wh_and_metrics(rows, B2B_COL_MAP,
        {"open", "rfp", "picking", "pack_ready", "packing",
         "ready_to_pick", "picking_started", "ready_to_pack", "packing_started"})


# ── Row mappers ───────────────────────────────────────────────────────────────
def map_b2c_row(row):
    out = {"updated_at": datetime.now(timezone.utc).isoformat()}
    for k, v in row.items():
        mapped = B2C_COL_MAP.get(k.lower().strip())
        if mapped:
            out[mapped] = v
    return out if "wh" in out else None


def map_b2b_row(row):
    out = {"updated_at": datetime.now(timezone.utc).isoformat()}
    for k, v in row.items():
        mapped = B2B_COL_MAP.get(k.lower().strip())
        if mapped:
            out[mapped] = v
    return out if "wh" in out else None


# ── Supabase upserts ──────────────────────────────────────────────────────────
def upsert(table, rows):
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    res = requests.post(url, headers=sb_headers(), json=rows, timeout=30)
    if not res.ok:
        print(f"  Supabase error {res.status_code}: {res.text}")
        res.raise_for_status()
    print(f"  ✓ Upserted {len(rows)} rows to {table}")


# ── Sync functions ────────────────────────────────────────────────────────────
def sync_dashboard(dashboard_id, label, card_detector, row_mapper, table):
    print(f"\n[{datetime.now().strftime('%H:%M:%S')}] Syncing {label} (dashboard {dashboard_id})…")
    if not dashboard_id:
        print(f"  Skipped — {label}_DASHBOARD_ID not set. Run --list to find it.")
        return False

    cards = get_dashboard_cards(dashboard_id)
    print(f"  Found {len(cards)} cards")

    synced = False
    for dc in cards:
        card = dc.get("card", {})
        card_id   = card.get("id")
        card_name = card.get("name", "?")
        if not card_id:
            continue
        print(f"  Trying card {card_id}: {card_name}…")
        try:
            rows = execute_card(card_id)
        except Exception as e:
            print(f"    Skipped ({e})")
            continue

        if card_detector(rows):
            print(f"  ✓ Matched: {card_name}")
            mapped = [row_mapper(r) for r in rows]
            mapped = [r for r in mapped if r and r.get("wh")]
            if mapped:
                upsert(table, mapped)
                synced = True
        else:
            print(f"    Not a {label} card — skipping")

    return synced


def list_all_cards():
    for label, did in [("B2C", B2C_DASHBOARD_ID), ("B2B", B2B_DASHBOARD_ID)]:
        if not did:
            print(f"\n{label}: dashboard ID not set")
            continue
        print(f"\nCards in {label} dashboard ({did}):")
        try:
            cards = get_dashboard_cards(did)
            for dc in cards:
                card = dc.get("card", {})
                print(f"  [{card.get('id')}] {card.get('name', '?')}")
        except Exception as e:
            print(f"  Error: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    args = set(sys.argv[1:])
    run_b2c = "--b2b" not in args  # default: both; --b2c or neither → run B2C
    run_b2b = "--b2c" not in args  # default: both; --b2b or neither → run B2B

    results = []

    if run_b2c:
        ok = sync_dashboard(B2C_DASHBOARD_ID, "B2C",
                            looks_like_b2c_card, map_b2c_row, "b2c_data")
        results.append(("B2C", ok))

    if run_b2b:
        ok = sync_dashboard(B2B_DASHBOARD_ID, "B2B",
                            looks_like_b2b_card, map_b2b_row, "b2b_data")
        results.append(("B2B", ok))

    print()
    for label, ok in results:
        if ok:
            print(f"✅ {label} sync complete — press Refresh in the app to see updated data.")
        else:
            print(f"⚠️  {label}: no matching card found. Run --list to see available cards.")


if __name__ == "__main__":
    if "--list" in sys.argv:
        list_all_cards()
    else:
        main()
