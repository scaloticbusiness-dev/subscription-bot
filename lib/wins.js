// lib/wins.js
// Tracks who posted in the configured "wins" channel and when, storing a
// link to each message (not its content — the bot doesn't have the
// privileged Message Content intent, so it can only see metadata: author,
// timestamp, and the message's own URL). The monthly digest is therefore
// a list of "who posted a win and when, click to see it" rather than a
// compiled summary of what was actually said.

const { google } = require('googleapis');

const WINS_LOG_SHEET_NAME = 'Wins Log';

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

async function ensureWinsLogSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === WINS_LOG_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: WINS_LOG_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${WINS_LOG_SHEET_NAME}!A1:C1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date', 'Author', 'Message Link']] },
  });

  console.log('Created "Wins Log" tab.');
}

/**
 * Logs one post in the wins channel.
 */
async function logWin({ date, author, link }) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${WINS_LOG_SHEET_NAME}!A:C`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[date, author, link]] },
  });
}

/**
 * Returns all logged wins with a date within [startDate, endDate)
 * (both plain "YYYY-MM-DD" strings).
 */
async function getWinsInRange(startDate, endDate) {
  const sheets = await getClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${WINS_LOG_SHEET_NAME}!A2:C`,
    });
  } catch (err) {
    return [];
  }

  const rows = res.data.values || [];
  return rows
    .map((r) => ({ date: r[0] || '', author: r[1] || '', link: r[2] || '' }))
    .filter((w) => w.date >= startDate && w.date < endDate);
}

module.exports = { ensureWinsLogSheet, logWin, getWinsInRange };
