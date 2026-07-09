# Daily Ops Webapp — Overview

A mobile-friendly internal tool for warehouse operations teams to monitor B2C order flow and report packing errors in real time. All data is backed by Google Sheets so it works without any dedicated backend infrastructure.

---

## Tabs

### B2C Dashboard
Shows live order counts for every warehouse, grouped by country. Each row displays four stages of the pick-and-pack pipeline:

| Column | Meaning |
|---|---|
| New | Orders received, not yet started |
| RFP | Ready for picking |
| Picking | Currently being picked |
| Picked | Completed |

Data is synced from Metabase into a Google Sheet every 30 minutes. A sync timestamp is shown at the top so the team always knows how fresh the numbers are.

### Errors
A log of all packing errors reported by the team. Records can be filtered by status (Active / Resolved) and searched by order ID, tote number, station, or error type. Each row can be expanded to show full details including photos.

Status can be updated inline (Open → In Progress → Resolved). Resolved records can be deleted individually or in bulk.

---

## Reporting an Error

A **Report Error** button floats on the B2C tab. Tapping it opens a form with the following fields:

- **Warehouse** — selected from the live warehouse list
- **Order ID** and **Tote Number** (required)
- **Packing Station** (optional)
- **Error Type** — one of: Wrong Item, Missing Item, Extra Item, Damaged Item, AWB Error, Other
- **SKU details** — for item-level errors, one or more rows of SKU / Qty / Pack Type
- **Notes** — for AWB errors or freeform descriptions
- **Photos** — take a photo with the device camera, or choose from the gallery

On submission:
1. Photos are resized to ≤ 1200 px and uploaded to a **Google Drive** folder (`PackingErrorPhotos`) so they are accessible from any device.
2. The record (including Drive photo IDs) is written to the **PackingErrors** Google Sheet.
3. A Slack notification is sent if a webhook is configured in Settings.
4. The Errors tab updates immediately.

---

## Viewing Photos

Expanding any error record in the Errors tab shows its attached photos as thumbnails. Tapping a thumbnail opens it fullscreen. Press Escape or tap outside to close.

Photos are stored in Google Drive and loaded via Drive thumbnail URLs, so they appear on every device — not just the one that submitted the report.

---

## Settings

Accessible via the gear icon. Allows the team to:

- Connect to the Google Apps Script web app (the backend that reads/writes the Google Sheet)
- Set a Slack webhook URL for error notifications
- View the app's QR code to quickly open it on another device

---

## Technical Stack

| Layer | Technology |
|---|---|
| Frontend | Single-file HTML/CSS/JS hosted on GitHub Pages |
| Backend | Google Apps Script web app (no server to maintain) |
| Database | Google Sheets (PackingErrors + B2CDashboard tabs) |
| Photo storage | Google Drive (PackingErrorPhotos folder) |
| Notifications | Slack Incoming Webhooks |
| B2C data source | Metabase → scheduled sync into Google Sheet |
