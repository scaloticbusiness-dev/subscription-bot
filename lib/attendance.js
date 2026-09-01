// lib/attendance.js
// Tracks who joined a voice channel and when, in an "Attendance Log" sheet
// tab. Used to correlate attendance with events in the "Events" tab (by
// time-window overlap, not a specific channel — simple but sufficient for
// a community with one live event happening at a time).

const { google } = require('googleapis');

const ATTENDANCE_LOG_SHEET_NAME = 'Attendance Log';

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

async function ensureAttendanceLogSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === ATTENDANCE_LOG_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: ATTENDANCE_LOG_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ATTENDANCE_LOG_SHEET_NAME}!A1:B1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Timestamp (ISO)', 'Discord Username']] },
  });

  console.log('Created "Attendance Log" tab.');
}

async function logAttendance(username) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${ATTENDANCE_LOG_SHEET_NAME}!A:B`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[new Date().toISOString(), username]] },
  });
}

/**
 * Returns the set of unique usernames with at least one logged join
 * inside [startIso, endIso).
 */
async function getAttendeesInWindow(startIso, endIso) {
  const sheets = await getClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${ATTENDANCE_LOG_SHEET_NAME}!A2:B`,
    });
  } catch (err) {
    return new Set();
  }

  const rows = res.data.values || [];
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();

  const attendees = new Set();
  for (const row of rows) {
    const ts = new Date(row[0]).getTime();
    if (isNaN(ts)) continue;
    if (ts >= start && ts < end && row[1]) attendees.add(row[1]);
  }
  return attendees;
}

module.exports = { ensureAttendanceLogSheet, logAttendance, getAttendeesInWindow };
