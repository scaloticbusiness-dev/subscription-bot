// lib/backup.js
// Creates a full timestamped copy of the subscription spreadsheet in Google
// Drive, as protection against accidental deletion/edits. Uses the same
// service account as lib/sheets.js, but needs the broader Drive scope (not
// just Sheets) since copying a whole file is a Drive operation.

const { google } = require('googleapis');

let driveClient = null;
let sheetsMetaClient = null;

async function getAuthClients() {
  if (driveClient && sheetsMetaClient) {
    return { drive: driveClient, sheets: sheetsMetaClient };
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  driveClient = google.drive({ version: 'v3', auth });
  sheetsMetaClient = google.sheets({ version: 'v4', auth });

  return { drive: driveClient, sheets: sheetsMetaClient };
}

/**
 * Creates a full copy of the subscription spreadsheet, named with today's
 * date, so there's always a recent snapshot to fall back on if something
 * gets accidentally deleted or overwritten in the live sheet.
 */
async function backupSheet() {
  const { drive, sheets } = await getAuthClients();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const originalTitle = meta.data.properties.title;
  const today = new Date().toISOString().slice(0, 10);
  const backupName = `${originalTitle} — Backup ${today}`;

  const res = await drive.files.copy({
    fileId: spreadsheetId,
    requestBody: { name: backupName },
  });

  return { id: res.data.id, name: res.data.name };
}

module.exports = { backupSheet };
