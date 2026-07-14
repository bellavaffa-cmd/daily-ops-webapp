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

const SPREADSHEET_ID    = '16KkpVrGUvqjScWPrleXfMNy2f_y1k8A7mvs1FrikxGg';
const SHEET_NAME        = 'PackingErrors';
const PICKING_SHEET_NAME = 'PickingIssues';


// ═══════════════════════════════════════════════════════════════════════════════
// WEB APP — routes requests from the webapp
// ═══════════════════════════════════════════════════════════════════════════════

function doGet(e) {
  const action = (e.parameter && e.parameter.action) || 'read';
  if (action === 'write')               return handleWrite(e);
  if (action === 'update')              return handleUpdate(e);
  if (action === 'delete')              return handleDelete(e);
  if (action === 'b2c_read')            return handleB2CRead();
  if (action === 'b2c_write')           return handleB2CWrite(e);
  if (action === 'b2c_sync_from_drive') return handleB2CSyncFromDrive(e);
  if (action === 'picking_read')         return handlePickingRead();
  if (action === 'picking_write')        return handlePickingWrite(e);
  if (action === 'picking_update')       return handlePickingUpdate(e);
  if (action === 'picking_delete')       return handlePickingDelete(e);
  return handleRead();
}

function doPost(e) {
  try {
    const body   = JSON.parse(e.postData.contents);
    const action = body.action || '';
    if (action === 'photo_upload') return handlePhotoUpload(body);
    return fail('Unknown POST action: ' + action);
  } catch (err) { return fail('doPost error: ' + err.toString()); }
}

// ── PackingErrors sheet ───────────────────────────────────────────────────────

function getSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['ID', 'Timestamp', 'Warehouse', 'OrderID', 'ToteNum', 'StationNum', 'ErrorType', 'Notes', 'Status', 'SKU', 'Photos']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 11).setFontWeight('bold');
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
        skus:       row[9] || '[]',
        photos:     row[10] || '[]'
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
      data.skus        || '[]',
      data.photos      || '[]'
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
        sheet.getRange(i + 1, 1, 1, 11).setValues([[
          data.id,
          data.timestamp   || values[i][1],
          data.warehouse   || values[i][2] || '',
          data.orderId     || '',
          data.toteNum     || '',
          data.stationNum  || '',
          data.errorType   || '',
          data.notes       || '',
          data.status      || '',
          data.skus        || values[i][9] || '[]',
          data.photos      !== undefined ? (data.photos || '[]') : (values[i][10] || '[]')
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

// ── PickingIssues sheet ───────────────────────────────────────────────────────
// Columns: ID | Timestamp | Warehouse | OrderID | SKU | IssueType |
//          PickedQty | ExpectedQty | Notes | Status

function getPickingSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(PICKING_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(PICKING_SHEET_NAME);
    sheet.appendRow(['ID', 'Timestamp', 'Warehouse', 'OrderID', 'SKU', 'IssueType', 'PickedQty', 'ExpectedQty', 'Notes', 'Status']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 10).setFontWeight('bold');
  }
  return sheet;
}

function handlePickingRead() {
  try {
    const sheet  = getPickingSheet();
    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) return ok({ data: [] });
    const rows = values.slice(1).map(function(row) {
      return {
        id:          row[0],
        timestamp:   row[1] instanceof Date ? row[1].toISOString() : row[1],
        warehouse:   row[2] || '',
        orderId:     row[3] || '',
        sku:         row[4] || '',
        issueType:   row[5] || '',
        pickedQty:   row[6] !== '' ? row[6] : '',
        expectedQty: row[7] !== '' ? row[7] : '',
        notes:       row[8] || '',
        status:      row[9] || 'Open'
      };
    });
    return ok({ data: rows });
  } catch (err) { return fail(err.toString()); }
}

function handlePickingWrite(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data  = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet = getPickingSheet();
    sheet.appendRow([
      data.id          || '',
      data.timestamp   || new Date().toISOString(),
      data.warehouse   || '',
      data.orderId     || '',
      data.sku         || '',
      data.issueType   || '',
      data.pickedQty   !== undefined ? data.pickedQty   : '',
      data.expectedQty !== undefined ? data.expectedQty : '',
      data.notes       || '',
      data.status      || 'Open'
    ]);
    return ok({ message: 'Picking issue appended' });
  } catch (err) { return fail(err.toString()); }
}

function handlePickingUpdate(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data   = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet  = getPickingSheet();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(data.id)) {
        sheet.getRange(i + 1, 1, 1, 10).setValues([[
          data.id,
          data.timestamp   || values[i][1],
          data.warehouse   !== undefined ? data.warehouse   : values[i][2],
          data.orderId     !== undefined ? data.orderId     : values[i][3],
          data.sku         !== undefined ? data.sku         : values[i][4],
          data.issueType   !== undefined ? data.issueType   : values[i][5],
          data.pickedQty   !== undefined ? data.pickedQty   : values[i][6],
          data.expectedQty !== undefined ? data.expectedQty : values[i][7],
          data.notes       !== undefined ? data.notes       : values[i][8],
          data.status      !== undefined ? data.status      : values[i][9]
        ]]);
        return ok({ message: 'Picking issue updated' });
      }
    }
    return fail('Row not found: ' + data.id);
  } catch (err) { return fail(err.toString()); }
}

function handlePickingDelete(e) {
  try {
    if (!e.parameter || !e.parameter.data) return fail('Missing data parameter');
    const data   = JSON.parse(decodeURIComponent(e.parameter.data));
    const sheet  = getPickingSheet();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(data.id)) {
        sheet.deleteRow(i + 1);
        return ok({ message: 'Picking issue deleted' });
      }
    }
    return fail('Row not found: ' + data.id);
  } catch (err) { return fail(err.toString()); }
}

// One-shot: run from Apps Script editor to create the PickingIssues sheet
function createPickingIssuesSheet() {
  const sheet = getPickingSheet();
  Logger.log('PickingIssues sheet ready: ' + sheet.getName());
}

// ── B2CDashboard sheet ────────────────────────────────────────────────────────

function getB2CSheet() {
  var ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName('B2CDashboard');
  if (!sheet) {
    sheet = ss.insertSheet('B2CDashboard');
    sheet.appendRow(['type', 'country', 'warehouse', 'new', 'rfp', 'picking', 'picked', 'sync_time']);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 8).setFontWeight('bold');
  }
  return sheet;
}

function handleB2CRead() {
  try {
    var sheet  = getB2CSheet();
    var values = sheet.getDataRange().getValues();
    if (values.length <= 1) return ok({ data: [], sync_time: '' });
    var sync_time = values[1][7] ? String(values[1][7]) : '';
    var rows = values.slice(1).map(function(r) {
      return { type: r[0], country: r[1], wh: r[2], new: Number(r[3]) || 0, rfp: Number(r[4]) || 0, picking: Number(r[5]) || 0, picked: Number(r[6]) || 0 };
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
    // Clear existing data rows (keep header)
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 8).clearContent();
    }
    if (rows.length) {
      var data = rows.map(function(r) {
        return [r.type || 'warehouse', r.country || '', r.wh || '', r.new || 0, r.rfp || 0, r.picking || 0, r.picked || 0, sync_time];
      });
      sheet.getRange(2, 1, data.length, 8).setValues(data);
    }
    return ok({ message: 'B2C data written', rows: rows.length });
  } catch (err) { return fail(err.toString()); }
}

// ── B2C sync from Google Drive JSON file ─────────────────────────────────────
// Triggered with: ?action=b2c_sync_from_drive&file_id=DRIVE_FILE_ID
// The Drive file must be a JSON with {rows:[{type,country,wh,new,rfp,picking,picked}], sync_time}
// This avoids URL-length limits when writing large datasets via GET parameters.

function handleB2CSyncFromDrive(e) {
  try {
    var fileId = e.parameter && e.parameter.file_id;
    if (!fileId) return fail('Missing file_id parameter');
    var file    = DriveApp.getFileById(fileId);
    var content = file.getBlob().getDataAsString();
    var parsed  = JSON.parse(content);
    var rows      = parsed.rows      || [];
    var sync_time = parsed.sync_time || new Date().toISOString();
    var sheet = getB2CSheet();
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, 8).clearContent();
    }
    if (rows.length) {
      var data = rows.map(function(r) {
        return [r.type || 'warehouse', r.country || '', r.wh || '', r.new || 0, r.rfp || 0, r.picking || 0, r.picked || 0, sync_time];
      });
      sheet.getRange(2, 1, data.length, 8).setValues(data);
    }
    return ok({ message: 'B2C data synced from Drive', rows: rows.length, file_id: fileId });
  } catch (err) { return fail(err.toString()); }
}

// ── Photo upload to Drive ─────────────────────────────────────────────────────

function handlePhotoUpload(body) {
  try {
    if (!body.data) return fail('Missing photo data');
    const base64 = body.data.replace(/^data:image\/\w+;base64,/, '');
    const mime   = body.mime || 'image/jpeg';
    const name   = 'error_' + Date.now() + '.jpg';

    // Get or create dedicated folder in Drive
    const folderName = 'PackingErrorPhotos';
    const iter = DriveApp.getFoldersByName(folderName);
    const folder = iter.hasNext() ? iter.next() : DriveApp.createFolder(folderName);

    // Decode base64 and save as file
    const bytes = Utilities.base64Decode(base64);
    const blob  = Utilities.newBlob(bytes, mime, name);
    const file  = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return ok({ fileId: file.getId() });
  } catch (err) { return fail('Photo upload error: ' + err.toString()); }
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


// ── One-shot runner (run from Apps Script editor) ────────────────────────────
// Run this function directly from the Apps Script editor to immediately
// sync the B2CDashboard from the latest Drive data file.
function runB2CSyncNow() {
  var e = { parameter: { file_id: '1mcm-ve6g2ZNjYTlvgQzA-RutrU3DYbTt' } };
  var result = handleB2CSyncFromDrive(e);
  Logger.log(result.getContent());
}
