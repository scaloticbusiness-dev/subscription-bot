// lib/mentions.js
// Tracks which items from a Google Alerts RSS feed have already been
// alerted on, storing them in a "Mentions Log" sheet tab so restarts
// don't cause duplicate alerts.

const { google } = require('googleapis');

const MENTIONS_LOG_SHEET_NAME = 'Mentions Log';

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

async function ensureMentionsLogSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === MENTIONS_LOG_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: MENTIONS_LOG_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${MENTIONS_LOG_SHEET_NAME}!A1:C1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date Seen', 'Title', 'Link']] },
  });

  console.log('Created "Mentions Log" tab.');
}

/**
 * Returns the set of links already logged, so the caller can filter out
 * mentions already alerted on.
 */
async function getSeenLinks() {
  const sheets = await getClient();
  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${MENTIONS_LOG_SHEET_NAME}!C2:C`,
    });
  } catch (err) {
    return new Set();
  }
  const rows = res.data.values || [];
  return new Set(rows.map((r) => r[0]).filter(Boolean));
}

async function logMention({ title, link }) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${MENTIONS_LOG_SHEET_NAME}!A:C`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[new Date().toISOString().slice(0, 10), title || '', link || '']] },
  });
}

module.exports = { ensureMentionsLogSheet, getSeenLinks, logMention };
