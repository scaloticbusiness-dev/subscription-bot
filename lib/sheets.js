// lib/sheets.js
// Reads/writes the subscription sheet.
// Expected columns (row 1 = headers):
// A Name | B Email | C Discord Username | D Date | E Renewal Date | F Status
// G Plan | H Amount | I Discord Joined | J Skool Invited | K Last Milestone
// L Expired Date | M Win Back Sent | N Check-in Sent | O Unsubscribed
// P Discord Last Active | Q Last Reengagement Sent | R Save Offer Sent
// S Upsell Sent | T ToS Accepted | U ToS Version | V Tax Country

const { google } = require('googleapis');

const RANGE_ALL = 'A2:V';
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
  'Last Milestone',
  'Expired Date',
  'Win Back Sent',
  'Check-in Sent',
  'Unsubscribed',
  'Discord Last Active',
  'Last Reengagement Sent',
  'Save Offer Sent',
  'Upsell Sent',
  'ToS Accepted',
  'ToS Version',
  'Tax Country',
];

const ARCHIVE_SHEET_NAME = 'Archive';
// Grid ID of the main data tab (Sheet1). Google Sheets assigns this when the
// spreadsheet is created; the first/default tab is always 0 unless someone
// has manually reordered/recreated sheets in a way that changes it.
const MAIN_SHEET_GRID_ID = 0;

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
    lastMilestone: row[10] || '',
    expiredDate: row[11] || '',
    winBackSent: row[12] || '',
    checkinSent: row[13] || '',
    unsubscribed: row[14] || '',
    discordLastActive: row[15] || '',
    lastReengagementSent: row[16] || '',
    saveOfferSent: row[17] || '',
    upsellSent: row[18] || '',
    tosAccepted: row[19] || '',
    tosVersion: row[20] || '',
    taxCountry: row[21] || '',
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
 * discordJoined/skoolInvited default to 'No', lastMilestone/expiredDate/
 * winBackSent default to '' for a freshly-created row.
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
  lastMilestone = '',
  expiredDate = '',
  winBackSent = '',
  checkinSent = '',
  unsubscribed = '',
  discordLastActive = '',
  lastReengagementSent = '',
  saveOfferSent = '',
  upsellSent = '',
  tosAccepted = '',
  tosVersion = '',
  taxCountry = '',
}) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName()}!A:V`,
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
        lastMilestone,
        expiredDate,
        winBackSent,
        checkinSent,
        unsubscribed,
        discordLastActive,
        lastReengagementSent,
        saveOfferSent,
        upsellSent,
        tosAccepted,
        tosVersion,
        taxCountry,
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
    lastMilestone: 'K',
    expiredDate: 'L',
    winBackSent: 'M',
    checkinSent: 'N',
    unsubscribed: 'O',
    discordLastActive: 'P',
    lastReengagementSent: 'Q',
    saveOfferSent: 'R',
    upsellSent: 'S',
    tosAccepted: 'T',
    tosVersion: 'U',
    taxCountry: 'V',
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
    range: `${sheetName()}!A1:V1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });
}

/**
 * Ensures an "Archive" tab exists in the spreadsheet, creating it (with the
 * same header row) if it doesn't. Safe to call repeatedly.
 */
async function ensureArchiveSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find(
    (s) => s.properties.title === ARCHIVE_SHEET_NAME
  );
  if (existing) return existing.properties.sheetId;

  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: ARCHIVE_SHEET_NAME } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ARCHIVE_SHEET_NAME}!A1:V1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });

  return res.data.replies[0].addSheet.properties.sheetId;
}

/**
 * Appends a full row (as already-fetched row data from getAllRows) to the
 * Archive tab, creating the tab first if needed.
 */
async function archiveRow(row) {
  await ensureArchiveSheet();

  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${ARCHIVE_SHEET_NAME}!A:V`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        row.name,
        row.email,
        row.discordUsername,
        row.date,
        row.renewalDate,
        row.status,
        row.plan,
        row.amount,
        row.discordJoined,
        row.skoolInvited,
        row.lastMilestone,
        row.expiredDate,
        row.winBackSent,
        row.checkinSent,
        row.unsubscribed,
        row.discordLastActive,
        row.lastReengagementSent,
        row.saveOfferSent,
        row.upsellSent,
        row.tosAccepted,
        row.tosVersion,
        row.taxCountry,
      ]],
    },
  });
}

/**
 * Deletes a single row (1-based row number) from the main data tab.
 * Used after archiving a row, so it isn't left duplicated in both places.
 */
async function deleteRow(rowNumber) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: MAIN_SHEET_GRID_ID,
              dimension: 'ROWS',
              startIndex: rowNumber - 1, // 0-indexed, inclusive
              endIndex: rowNumber, // 0-indexed, exclusive
            },
          },
        },
      ],
    },
  });
}

/**
 * Finds a row in the Archive tab by email (case-insensitive). Returns null
 * if the tab doesn't exist yet or no matching row is found. Used by the
 * GDPR export endpoint, since archived (long-expired) customers are no
 * longer in the main data tab.
 */
async function findArchivedRowByEmail(email) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${ARCHIVE_SHEET_NAME}!${RANGE_ALL}`,
    });
  } catch (err) {
    // Archive tab doesn't exist yet — nothing archived, nothing to find.
    return null;
  }

  const rows = res.data.values || [];
  const match = rows.find((row) => (row[1] || '').toLowerCase() === (email || '').toLowerCase());
  if (!match) return null;

  return {
    name: match[0] || '',
    email: match[1] || '',
    discordUsername: match[2] || '',
    date: match[3] || '',
    renewalDate: match[4] || '',
    status: match[5] || '',
    plan: match[6] || '',
    amount: match[7] || '',
    discordJoined: match[8] || '',
    skoolInvited: match[9] || '',
    lastMilestone: match[10] || '',
    expiredDate: match[11] || '',
    winBackSent: match[12] || '',
    checkinSent: match[13] || '',
    unsubscribed: match[14] || '',
    discordLastActive: match[15] || '',
    lastReengagementSent: match[16] || '',
    saveOfferSent: match[17] || '',
    upsellSent: match[18] || '',
    tosAccepted: match[19] || '',
    tosVersion: match[20] || '',
    taxCountry: match[21] || '',
  };
}

module.exports = {
  getAllRows,
  findRowByEmail,
  findArchivedRowByEmail,
  findRowByDiscordUsername,
  appendRow,
  updateRow,
  ensureHeaderRow,
  archiveRow,
  deleteRow,
};
