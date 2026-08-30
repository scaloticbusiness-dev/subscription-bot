// lib/leads.js
// Reads/writes the leads sheet (form submissions from lotik.gr). Unlike
// lib/sheets.js, this reads the header row dynamically instead of assuming
// fixed columns — the form's own columns (Ημερομηνία, Όνομα, Email, etc.)
// stay untouched; we only append two tracking columns at the end.

const { google } = require('googleapis');

let sheetsClient = null;

async function getClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

function spreadsheetId() {
  return process.env.GOOGLE_LEADS_SHEET_ID;
}

function sheetName() {
  return process.env.GOOGLE_LEADS_SHEET_NAME || 'Αιτήσεις';
}

/**
 * Converts a 0-based column index to a spreadsheet column letter (A, B, ...
 * Z, AA, AB, ...). The form has well under 26 columns, but this is safe
 * either way.
 */
function colLetter(index) {
  let letter = '';
  let n = index;
  do {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letter;
}

async function getHeaders() {
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName()}!A1:Z1`,
  });
  return res.data.values?.[0] || [];
}

/**
 * Ensures the two tracking columns exist at the end of the header row,
 * without touching any of the form's own columns. Safe to call repeatedly.
 * Returns the column letters actually used for each.
 */
async function ensureTrackingColumns() {
  const headers = await getHeaders();
  let autoReplyIdx = headers.indexOf('Auto Reply Sent');
  let nurtureIdx = headers.indexOf('Nurture Sent');

  const updates = [];
  const workingHeaders = [...headers];

  if (autoReplyIdx === -1) {
    autoReplyIdx = workingHeaders.length;
    updates.push({
      range: `${sheetName()}!${colLetter(autoReplyIdx)}1`,
      values: [['Auto Reply Sent']],
    });
    workingHeaders.push('Auto Reply Sent');
  }
  if (nurtureIdx === -1) {
    nurtureIdx = workingHeaders.length;
    updates.push({
      range: `${sheetName()}!${colLetter(nurtureIdx)}1`,
      values: [['Nurture Sent']],
    });
    workingHeaders.push('Nurture Sent');
  }

  if (updates.length > 0) {
    const sheets = await getClient();
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }

  return { autoReplyCol: colLetter(autoReplyIdx), nurtureCol: colLetter(nurtureIdx) };
}

/**
 * Returns all lead rows, using the header row to find the relevant columns
 * (Ημερομηνία, Όνομα, Email, plus the two tracking columns) wherever they
 * happen to be, rather than assuming fixed positions.
 */
async function getAllLeads() {
  const sheets = await getClient();
  const headers = await getHeaders();

  const dateIdx = headers.indexOf('Ημερομηνία');
  const firstNameIdx = headers.indexOf('Όνομα');
  const emailIdx = headers.indexOf('Email');
  const pageIdx = headers.indexOf('Σελίδα');
  const autoReplyIdx = headers.indexOf('Auto Reply Sent');
  const nurtureIdx = headers.indexOf('Nurture Sent');

  const lastColIndex = Math.max(headers.length - 1, 0);
  const lastCol = colLetter(lastColIndex);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName()}!A2:${lastCol}`,
  });

  const rows = res.data.values || [];
  return rows.map((row, idx) => ({
    rowNumber: idx + 2,
    date: dateIdx >= 0 ? row[dateIdx] || '' : '',
    firstName: firstNameIdx >= 0 ? row[firstNameIdx] || '' : '',
    email: emailIdx >= 0 ? row[emailIdx] || '' : '',
    page: pageIdx >= 0 ? row[pageIdx] || '' : '',
    autoReplySent: autoReplyIdx >= 0 ? row[autoReplyIdx] || '' : '',
    nurtureSent: nurtureIdx >= 0 ? row[nurtureIdx] || '' : '',
  }));
}

/**
 * Writes a single value into a specific column (by letter) for a given row.
 */
async function markLeadField(rowNumber, columnLetter, value) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${sheetName()}!${columnLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

module.exports = { ensureTrackingColumns, getAllLeads, markLeadField, colLetter };
