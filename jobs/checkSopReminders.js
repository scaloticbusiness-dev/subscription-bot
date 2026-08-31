// jobs/checkSopReminders.js
// Runs once a week (bundled with the other Monday jobs). Reads a "SOP" tab
// in the main spreadsheet (one recurring task per row, column A) and
// emails the whole list as a checklist reminder. Creates the tab with a
// few starter example tasks if it doesn't exist yet, so the admin has
// something to edit rather than an empty tab.

const { google } = require('googleapis');
const { sendSopReminder } = require('../lib/email');

const SOP_SHEET_NAME = 'SOP';

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

async function ensureSopSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === SOP_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SOP_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SOP_SHEET_NAME}!A1:A5`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        ['Recurring Task'],
        ['Έλεγξε τα flagged spam leads στο leads sheet'],
        ['Έλεγξε ανοιχτά chargebacks/disputes στο Stripe'],
        ['Επιβεβαίωσε ότι το weekly backup ολοκληρώθηκε'],
        ['Απάντησε σε εκκρεμή Skool invite reminders'],
      ],
    },
  });

  console.log('Created "SOP" tab with starter example tasks.');
}

async function getSopTasks() {
  const sheets = await getClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${SOP_SHEET_NAME}!A2:A`,
    });
  } catch (err) {
    return [];
  }
  const rows = res.data.values || [];
  return rows.map((r) => r[0]).filter(Boolean);
}

async function checkSopReminders() {
  console.log(`[${new Date().toISOString()}] Running weekly SOP reminder job...`);

  try {
    await ensureSopSheet();
  } catch (err) {
    console.error('Could not verify/create the SOP tab:', err.message);
    return;
  }

  const tasks = await getSopTasks();
  try {
    await sendSopReminder(tasks);
  } catch (err) {
    console.error('Failed to send SOP reminder:', err.message);
  }

  console.log(`SOP reminder job complete (${tasks.length} task(s)).`);
}

module.exports = { checkSopReminders };
