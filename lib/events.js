// lib/events.js
// Reads/writes an "Events" tab in the main spreadsheet for scheduled
// live Q&A/webinar events. Admin adds a row per event; the reminder job
// (jobs/checkEventReminders.js) reads this and sends reminders at 24h,
// 1h, and 10min before the event, tracking each via its own "sent" column
// so nothing is ever sent twice.
//
// Expected columns: A Event Name | B DateTime (ISO, e.g.
// 2026-09-05T18:00:00Z) | C Description | D Link | E Reminder 24h Sent
// | F Reminder 1h Sent | G Reminder 10min Sent | H Discord Event Created
// | I Wrapup Processed

const { google } = require('googleapis');

const EVENTS_SHEET_NAME = 'Events';
const HEADER_ROW = [
  'Event Name',
  'DateTime (ISO)',
  'Description',
  'Link',
  'Reminder 24h Sent',
  'Reminder 1h Sent',
  'Reminder 10min Sent',
  'Discord Event Created',
  'Wrapup Processed',
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

/**
 * Ensures the "Events" tab exists, creating it with headers if it doesn't.
 * Safe to call on every startup.
 */
async function ensureEventsSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === EVENTS_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: EVENTS_SHEET_NAME } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${EVENTS_SHEET_NAME}!A1:I1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });

  console.log('Created "Events" tab.');
}

/**
 * Returns all events as objects, tagged with their 1-based sheet row
 * number for later updates.
 */
async function getAllEvents() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${EVENTS_SHEET_NAME}!A2:I`,
    });
  } catch (err) {
    return []; // tab doesn't exist yet
  }

  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({
      rowNumber: idx + 2,
      name: row[0] || '',
      dateTime: row[1] || '',
      description: row[2] || '',
      link: row[3] || '',
      reminder24hSent: row[4] || '',
      reminder1hSent: row[5] || '',
      reminder10minSent: row[6] || '',
      discordEventCreated: row[7] || '',
      wrapupProcessed: row[8] || '',
    }))
    .filter((e) => e.name && e.dateTime);
}

/**
 * Marks a specific reminder column as sent for one event row.
 */
async function markReminderSent(rowNumber, column) {
  const columnLetter = {
    reminder24hSent: 'E',
    reminder1hSent: 'F',
    reminder10minSent: 'G',
    discordEventCreated: 'H',
    wrapupProcessed: 'I',
  }[column];
  if (!columnLetter) return;

  const sheets = await getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${EVENTS_SHEET_NAME}!${columnLetter}${rowNumber}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Yes']] },
  });
}

module.exports = { ensureEventsSheet, getAllEvents, markReminderSent };
