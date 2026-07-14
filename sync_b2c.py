#!/usr/bin/env python3
"""
sync_b2c.py — Sync B2C fulfillment data from Metabase dashboard to Supabase.

Usage:
  1. Fill in METABASE_API_KEY below (Metabase → Admin Settings → API Keys → Create).
  2. Run:  python3 sync_b2c.py
  3. Optionally schedule with cron:  0 * * * * python3 /path/to/sync_b2c.py

The script:
  - Fetches all cards from the Daily Ops dashboard (ID 479)
  - Auto-detects the card with warehouse/fulfillment data
  - Upserts rows to Supabase b2c_data table
  - App reads from Supabase so all instances get fresh data automatically
"""

import requests
import json
import sys
from datetime import datetime, timezone

# ── Config ────────────────────────────────────────────────────────────────────
METABASE_URL    = "https://metabase.golocad.com"
METABASE_API_KEY = ""          # Paste your API key here
DASHBOARD_ID    = 479          # Daily Ops dashboard

SUPABASE_URL    = "https://hmpkjmnxoidesnnoecfm.supabase.co"
SUPABASE_KEY    = "sb_publishable_00pJSeJ3cKuxqwelQbaKWg_uJe7XPtP"

# Column name mapping: Metabase column → Supabase column
# Edit these if your Metabase column names differ.
COL_MAP = {
    "warehouse":    "wh",
    "wh":           "wh",
    "warehouse_name": "wh",
    "new":          "new",
    "new_orders":   "new",
    "rfp":          "rfp",
    "ready_for_picking": "rfp",
    "picking":      "picking",
    "in_picking":   "picking",
    "picked":       "picked",
    "total_picked": "picked",
}

# ── Helpers ───────────────────────────────────────────────────────────────────
def mb_headers():
    if not METABASE_API_KEY:
        print("ERROR: METABASE_API_KEY is not set. Edit sync_b2c.py and add your API key.")
        sys.exit(1)
    return {"x-api-key": METABASE_API_KEY, "Content-Type": "application/json"}


def sb_headers():
    return {
        "apikey":        SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type":  "application/json",
        "Prefer":        "resolution=merge-duplicates",
    }


def get_dashboard_cards():
    url = f"{METABASE_URL}/api/dashboard/{DASHBOARD_ID}"
    res = requests.get(url, headers=mb_headers(), timeout=30)
    res.raise_for_status()
    data = res.json()
    return data.get("dashcards", [])


def execute_card(card_id):
    url = f"{METABASE_URL}/api/card/{card_id}/query/json"
    res = requests.post(url, headers=mb_headers(), timeout=60)
    res.raise_for_status()
    return res.json()  # list of row dicts


def looks_like_b2c_card(rows):
    """Return True if this card's rows look like warehouse fulfillment data."""
    if not rows or not isinstance(rows, list) or not isinstance(rows[0], dict):
        return False
    keys = {k.lower().strip() for k in rows[0].keys()}
    # Must have something that maps to 'wh' and at least one numeric metric
    has_wh     = any(k in COL_MAP for k in keys)
    has_metric = any(k in ("new", "rfp", "picking", "picked",
                            "new_orders", "ready_for_picking",
                            "in_picking", "total_picked") for k in keys)
    return has_wh and has_metric


def map_row(row):
    """Convert a Metabase row dict to a Supabase b2c_data row."""
    out = {"updated_at": datetime.now(timezone.utc).isoformat()}
    for k, v in row.items():
        mapped = COL_MAP.get(k.lower().strip())
        if mapped:
            out[mapped] = v
    return out if "wh" in out else None


def upsert_to_supabase(rows):
    url = f"{SUPABASE_URL}/rest/v1/b2c_data"
    res = requests.post(url, headers=sb_headers(), json=rows, timeout=30)
    if not res.ok:
        print(f"  Supabase error {res.status_code}: {res.text}")
        res.raise_for_status()
    print(f"  ✓ Upserted {len(rows)} warehouses to Supabase")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Fetching dashboard {DASHBOARD_ID}…")

    cards = get_dashboard_cards()
    print(f"  Found {len(cards)} cards in dashboard")

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

        if looks_like_b2c_card(rows):
            print(f"  ✓ Found B2C data in card {card_id}: {card_name}")
            mapped = [map_row(r) for r in rows]
            mapped = [r for r in mapped if r and r.get("wh")]
            if mapped:
                upsert_to_supabase(mapped)
                synced = True
                # Don't break — there may be multiple B2C cards (e.g. country totals)
        else:
            print(f"    Not a warehouse card — skipping")

    if synced:
        print(f"\n✅ Done. Open the app and press Refresh to see updated data.")
    else:
        print("\n⚠️  No B2C warehouse card found.")
        print("   Run with --list to see all card names and pick the right card_id.")
        print("   Then hardcode:  CARD_ID = <id>  and re-run.")


def list_cards():
    """Helper mode: print all card names so you can identify the right one."""
    cards = get_dashboard_cards()
    print(f"Cards in dashboard {DASHBOARD_ID}:")
    for dc in cards:
        card = dc.get("card", {})
        print(f"  [{card.get('id')}] {card.get('name', '?')}")


if __name__ == "__main__":
    if "--list" in sys.argv:
        list_cards()
    else:
        main()
