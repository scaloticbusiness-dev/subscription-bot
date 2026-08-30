// lib/sheets.js
// Reads/writes the subscription sheet.
// Expected columns (row 1 = headers):
// A Name | B Email | C Discord Username | D Date | E Renewal Date | F Status
// G Plan | H Amount | I Discord Joined | J Skool Invited

const { google } = require('googleapis');

const RANGE_ALL = 'A2:J';
const HEADER_ROW = [
  'Name',
  'Email',
  'Discord Username',
  'Date',
  'Renewal Date',
  'Status',
  'Plan',
  'Amount',
  'Discord Joined',
  'Skool Invited',
];

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

function sheetName() {
  return process.env.GOOGLE_SHEET_NAME || 'Sheet1';
}

/**
 * Returns all data rows (excluding the header row) as an array of objects,
 * each tagged with its 1-based sheet row number (rowNumber) for later updates.
 */
async function getAllRows() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName()}!${RANGE_ALL}`,
  });

  const rows = res.data.values || [];
  return rows.map((row, idx) => ({
    rowNumber: idx + 2, // +2 because data starts at row 2
    name: row[0] || '',
    email: row[1] || '',
    discordUsername: row[2] || '',
    date: row[3] || '',
    renewalDate: row[4] || '',
    status: row[5] || '',
    plan: row[6] || '',
    amount: row[7] || '',
    discordJoined: row[8] || '',
    skoolInvited: row[9] || '',
  }));
}

/**
 * Finds an existing row by email (case-insensitive). Returns null if not found.
 */
async function findRowByEmail(email) {
  const rows = await getAllRows();
  return rows.find((r) => r.email.toLowerCase() === (email || '').toLowerCase()) || null;
}

/**
 * Finds an existing row by Discord username (case-insensitive). Returns null if not found.
 */
async function findRowByDiscordUsername(discordUsername) {
  const rows = await getAllRows();
  return (
    rows.find(
      (r) => r.discordUsername.toLowerCase() === (discordUsername || '').toLowerCase()
    ) || null
  );
}

/**
 * Appends a brand new row at the bottom of the sheet.
 * discordJoined/skoolInvited default to 'No' for a freshly-created row.
 */
async function appendRow({
  name,
  email,
  discordUsername,
  date,
  renewalDate,
  status,
  plan,
  amount,
  discordJoined = 'No',
  skoolInvited = 'No',
}) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName()}!A:J`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        name,
        email,
        discordUsername,
        date,
        renewalDate,
        status,
        plan,
        amount,
        discordJoined,
        skoolInvited,
      ]],
    },
  });
}

/**
 * Updates specific columns of an existing row (1-based sheet row number).
 * `fields` is a partial object, e.g. { status: 'Expired' }.
 */
async function updateRow(rowNumber, fields) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const columnMap = {
    name: 'A',
    email: 'B',
    discordUsername: 'C',
    date: 'D',
    renewalDate: 'E',
    status: 'F',
    plan: 'G',
    amount: 'H',
    discordJoined: 'I',
    skoolInvited: 'J',
  };

  const requests = Object.entries(fields).map(([key, value]) => {
    const col = columnMap[key];
    return {
      range: `${sheetName()}!${col}${rowNumber}`,
      values: [[value]],
    };
  });

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: requests,
    },
  });
}

/**
 * Ensures the header row (row 1) has the correct labels.
 * Safe to call on every startup — it will not touch data rows.
 */
async function ensureHeaderRow() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName()}!A1:J1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });
}

module.exports = {
  getAllRows,
  findRowByEmail,
  findRowByDiscordUsername,
  appendRow,
  updateRow,
  ensureHeaderRow,
};
