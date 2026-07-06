// ─────────────────────────────────────────────────────────────────────────────
// Packing Error Report — Google Apps Script backend
//
// SETUP:
//   1. Create a new Google Sheet. Copy its ID from the URL:
//      https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit
//   2. Paste the ID into SPREADSHEET_ID below.
//   3. In the sheet: Extensions → Apps Script → paste this entire file → Save.
//   4. Deploy → New deployment → Web app (Execute as: Me, Anyone can access).
//   5. Copy the Web App URL into packing-error-report.html (Connect to Google Sheets).
//
// NOTE: B2CDashboard is populated by the Cowork connector sync every 30 minutes.
//       No Metabase credentials are needed here.
// ─────────────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = 'YOUR_SPREADSHEET_ID_HERE'; // ← replace this
const SHEET_NAME     = 'PackingErrors';


// ═══════════════════════════════════════════════════════════════════════════════
// WEB APP — routes requests from the webapp
// ═══════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'read';
  if (action === 'write')     return handleWrite(e);
  if (action === 'update')    return handleUpdate(e);
  if (action === 'delete')    return handleDelete(e);
  if (action === 'b2c_read')  return handleB2CRead();
  if (action === 'b2c_write') return handleB2CWrite(e);
  return handleRead();
}

// ── PackingErrors sheet ───────────────────────────────────────────────────────

function getSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['ID', 'Timestamp', 'Warehouse', 'OrderID', 'ToteNum', 'StationNum', 'ErrorType', 'Notes', 'Status', 'SKU']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
  }
  return sheet;
}

function handleRead() {
  try {
    const sheet  = getSheet();
    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) return ok({ data: [] });
    const rows = values.slice(1).map(function(row) {
      return {
        id:         row[0],
        timestamp:  row[1] instanceof Date ? row[1].toISOString() : row[1],
        warehouse:  row[2] || '',
        orderId:    row[3],
        toteNum:    row[4],
        stationNum: row[5],
        errorType:  row[6],
        notes:      row[7] || '',
        status:     row[8] || 'Open',
        skus:       row[9] || '[]'
      };
    });
    return ok({ data: rows });
  } catch (err) { return fail(err.toString()); }
}

function handleWrite(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data  = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet = getSheet();
    sheet.appendRow([
      data.id          || '',
      data.timestamp   || new Date().toISOString(),
      data.warehouse   || '',
      data.orderId     || '',
      data.toteNum     || '',
      data.stationNum  || '',
      data.errorType   || '',
      data.notes       || '',
      data.status      || 'Open',
      data.skus        || '[]'
    ]);
    return ok({ message: 'Row appended' });
  } catch (err) { return fail(err.toString()); }
}

function handleUpdate(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data   = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet  = getSheet();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(data.id)) {
        sheet.getRange(i + 1, 1, 1, 10).setValues([[
          data.id,
          data.timestamp   || values[i][1],
          data.warehouse   || values[i][2] || '',
          data.orderId     || '',
          data.toteNum     || '',
          data.stationNum  || '',
          data.errorType   || '',
          data.notes       || '',
          data.status      || '',
          data.skus        || values[i][9] || '[]'
        ]]);
        return ok({ message: 'Row updated' });
      }
    }
    return fail('Row not found: ' + data.id);
  } catch (err) { return fail(err.toString()); }
}

function handleDelete(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data   = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet  = getSheet();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(data.id)) {
        sheet.deleteRow(i + 1);
        return ok({ message: 'Row deleted' });
      }
    }
    return fail('Row not found: ' + data.id);
  } catch (err) { return fail(err.toString()); }
}

// ── B2CDashboard sheet ────────────────────────────────────────────────────────

function getB2CSheet() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('B2CDashboard');
  if (!sheet) {
    sheet = ss.insertSheet('B2CDashboard');
    sheet.appendRow(['warehouse', 'open', 'rfp', 'picking', 'picked', 'sync_time']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  }
  return sheet;
}

function handleB2CRead() {
  try {
    var sheet  = getB2CSheet();
    var values = sheet.getDataRange().getValues();
    if (values.length <= 1) return ok({ data: [], sync_time: '' });
    var sync_time = values[1][5] ? String(values[1][5]) : '';
    var rows = values.slice(1).map(function(r) {
      return { wh: r[0], new: Number(r[1]) || 0, rfp: Number(r[2]) || 0, picking: Number(r[3]) || 0, picked: Number(r[4]) || 0 };
    });
    return ok({ data: rows, sync_time: sync_time });
  } catch (err) { return fail(err.toString()); }
}

function handleB2CWrite(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    var parsed    = JSON.parse(decodeURIComponent(e.parameter.data));
    var rows      = parsed.rows      || [];
    var sync_time = parsed.sync_time || new Date().toISOString();
    var sheet = getB2CSheet();
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).clearContent();
    }
    if (rows.length) {
      var data = rows.map(function(r) {
        return [r.wh, r.new || 0, r.rfp || 0, r.picking || 0, r.picked || 0, sync_time];
      });
      sheet.getRange(2, 1, data.length, 6).setValues(data);
    }
    return ok({ message: 'B2C data written', rows: rows.length });
  } catch (err) { return fail(err.toString()); }
}

// ── Response helpers ──────────────────────────────────────────────────────────

function ok(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(Object.assign({ success: true }, payload)))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail(error) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: error }))
    .setMimeType(ContentService.MimeType.JSON);
}


// B2CDashboard is populated externally by the Cowork connector every 30 minutes.
// No Metabase credentials or sync functions are needed in this file.
