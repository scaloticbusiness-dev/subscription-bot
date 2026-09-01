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

/**
 * Sanity-checks a freshly created backup copy by actually opening it back
 * up and comparing it against the live spreadsheet — instead of just
 * trusting that `drive.files.copy` succeeding means the backup is good.
 * Checks two things: (1) every tab that exists on the live spreadsheet
 * (Sheet1, Archive, Referrals, Exit Feedback, ...) also exists on the
 * backup copy, and (2) the main data tab has roughly the same number of
 * rows on both. A backup nobody has ever tried to read back is really
 * just an assumption; this turns it into something actually verified,
 * every single week, before it's ever needed for real.
 */
async function verifyBackup(backupFileId) {
    const { sheets } = await getAuthClients();
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    const mainSheetName = process.env.GOOGLE_SHEET_NAME || 'Sheet1';

  const [liveMeta, backupMeta] = await Promise.all([
        sheets.spreadsheets.get({ spreadsheetId }),
        sheets.spreadsheets.get({ spreadsheetId: backupFileId }),
      ]);

  const liveTabs = liveMeta.data.sheets.map((s) => s.properties.title);
    const backupTabs = new Set(backupMeta.data.sheets.map((s) => s.properties.title));
    const missingTabs = liveTabs.filter((title) => !backupTabs.has(title));

  const [liveValues, backupValues] = await Promise.all([
        sheets.spreadsheets.values.get({ spreadsheetId, range: `${mainSheetName}!A2:A` }),
        sheets.spreadsheets.values.get({ spreadsheetId: backupFileId, range: `${mainSheetName}!A2:A` }),
      ]);

  const liveRowCount = (liveValues.data.values || []).length;
    const backupRowCount = (backupValues.data.values || []).length;

  // -1 tolerance: guards only against a single row being added to the live
  // sheet in the brief gap between the backup copy and this check (e.g. a
  // checkout completing at that exact moment) — not a real integrity gap.
  const ok = missingTabs.length === 0 && backupRowCount >= liveRowCount - 1;

  return { ok, missingTabs, liveRowCount, backupRowCount };
}

module.exports = { backupSheet, verifyBackup };
