// lib/transcripts.js
// Reads/writes a "Transcripts" tab in the main spreadsheet, storing
// speech-to-text results from the /transcribe command so they're
// searchable later.

const { google } = require('googleapis');

const TRANSCRIPTS_SHEET_NAME = 'Transcripts';

// Google Sheets caps a single cell at 50,000 characters — truncate
// defensively so a very long video doesn't fail the write outright.
const MAX_CELL_CHARS = 49000;

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
 * Ensures the "Transcripts" tab exists, creating it with headers if it
 * doesn't. Safe to call repeatedly.
 */
async function ensureTranscriptsSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TRANSCRIPTS_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TRANSCRIPTS_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TRANSCRIPTS_SHEET_NAME}!A1:E1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Date', 'Title', 'Source Link', 'Duration (min)', 'Transcript']] },
  });

  console.log('Created "Transcripts" tab.');
}

/**
 * Appends one transcript as a new row.
 */
async function saveTranscript({ title, sourceLink, durationSeconds, text }) {
  const sheets = await getClient();
  const durationMin = durationSeconds ? (durationSeconds / 60).toFixed(1) : '';
  const truncated = text.length > MAX_CELL_CHARS
    ? `${text.slice(0, MAX_CELL_CHARS)}\n\n[...περικομμένο, ξεπέρασε το όριο μεγέθους ενός κελιού...]`
    : text;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${TRANSCRIPTS_SHEET_NAME}!A:E`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[new Date().toISOString().slice(0, 10), title || '', sourceLink || '', durationMin, truncated]],
    },
  });
}

module.exports = { ensureTranscriptsSheet, saveTranscript };
