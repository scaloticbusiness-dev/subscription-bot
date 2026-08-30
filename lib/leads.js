// lib/leads.js
// Reads/writes the leads sheet (form submissions from lotik.gr). Unlike
// lib/sheets.js, this reads the header row dynamically instead of assuming
// fixed columns — the form's own columns (Ημερομηνία, Όνομα, Email, etc.)
// stay untouched; we only append tracking columns at the end.

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
 * Looks up the column letter for a given header name, or null if it's not
 * found. Useful for writing back to a column the form itself created
 * (e.g. "Τηλέφωνο") without hardcoding its position.
 */
async function getColumnLetter(headerName) {
  const headers = await getHeaders();
  const idx = headers.indexOf(headerName);
  return idx >= 0 ? colLetter(idx) : null;
}

/**
 * Ensures our tracking columns exist at the end of the header row, without
 * touching any of the form's own columns. Safe to call repeatedly. Returns
 * the column letters actually used for each.
 */
async function ensureTrackingColumns() {
  const headers = await getHeaders();
  const trackingNames = ['Auto Reply Sent', 'Nurture Sent', 'Launch Email Sent', 'Spam Flagged'];
  const workingHeaders = [...headers];
  const updates = [];
  const result = {};

  const keyForName = {
    'Auto Reply Sent': 'autoReplyCol',
    'Nurture Sent': 'nurtureCol',
    'Launch Email Sent': 'launchCol',
    'Spam Flagged': 'spamCol',
  };

  for (const name of trackingNames) {
    let idx = workingHeaders.indexOf(name);
    if (idx === -1) {
      idx = workingHeaders.length;
      updates.push({ range: `${sheetName()}!${colLetter(idx)}1`, values: [[name]] });
      workingHeaders.push(name);
    }
    result[keyForName[name]] = colLetter(idx);
  }

  if (updates.length > 0) {
    const sheets = await getClient();
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }

  return result;
}

/**
 * Returns all lead rows, using the header row to find the relevant columns
 * (Ημερομηνία, Όνομα, Email, Τηλέφωνο, plus the tracking columns) wherever
 * they happen to be, rather than assuming fixed positions.
 */
async function getAllLeads() {
  const sheets = await getClient();
  const headers = await getHeaders();

  const dateIdx = headers.indexOf('Ημερομηνία');
  const firstNameIdx = headers.indexOf('Όνομα');
  const emailIdx = headers.indexOf('Email');
  const phoneIdx = headers.indexOf('Τηλέφωνο');
  const pageIdx = headers.indexOf('Σελίδα');
  const autoReplyIdx = headers.indexOf('Auto Reply Sent');
  const nurtureIdx = headers.indexOf('Nurture Sent');
  const launchIdx = headers.indexOf('Launch Email Sent');
  const spamIdx = headers.indexOf('Spam Flagged');

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
    phone: phoneIdx >= 0 ? row[phoneIdx] || '' : '',
    page: pageIdx >= 0 ? row[pageIdx] || '' : '',
    autoReplySent: autoReplyIdx >= 0 ? row[autoReplyIdx] || '' : '',
    nurtureSent: nurtureIdx >= 0 ? row[nurtureIdx] || '' : '',
    launchSent: launchIdx >= 0 ? row[launchIdx] || '' : '',
    spamFlagged: spamIdx >= 0 ? row[spamIdx] || '' : '',
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

/**
 * Returns every lead row matching the given email (case-insensitive) — a
 * person could in theory have submitted the form more than once. Used by
 * the GDPR export endpoint.
 */
async function findLeadsByEmail(email) {
  const leads = await getAllLeads();
  return leads.filter((l) => l.email && l.email.toLowerCase() === (email || '').toLowerCase());
}

module.exports = {
  ensureTrackingColumns,
  getAllLeads,
  findLeadsByEmail,
  markLeadField,
  getColumnLetter,
  colLetter,
};
