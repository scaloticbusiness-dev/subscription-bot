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

/**
 * Returns every saved transcript as an array of objects. Used by
 * searchTranscripts below (and available directly if ever needed).
 */
async function getAllTranscripts() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${TRANSCRIPTS_SHEET_NAME}!A2:E`,
    });
  } catch (err) {
    console.warn('Could not read the "Transcripts" tab (has it been created yet?):', err.message);
    return [];
  }

  const rows = res.data.values || [];
  return rows
    .filter((r) => r[1]) // needs at least a title
    .map((r) => ({
      date: r[0] || '',
      title: r[1] || '',
      sourceLink: r[2] || '',
      durationMin: r[3] || '',
      transcript: r[4] || '',
    }));
}

/**
 * Builds a short snippet of `text` centered on the first occurrence of
 * `query` (case-insensitive), so search results show *where* the term
 * came up instead of just confirming that it did.
 */
function buildSnippet(text, query, contextChars = 80) {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);
  if (idx === -1) return text.slice(0, contextChars * 2).trim();

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + lowerQuery.length + contextChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Searches every saved transcript's title + full text for `query`
 * (case-insensitive substring match), ranked by how many times it comes
 * up (more mentions ≈ more relevant to that lesson). Returns up to
 * `limit` results as { title, sourceLink, durationMin, snippet }.
 */
async function searchTranscripts(query, limit = 3) {
  const lowerQuery = (query || '').trim().toLowerCase();
  if (!lowerQuery) return [];

  const transcripts = await getAllTranscripts();

  const scored = transcripts
    .map((t) => {
      const haystack = `${t.title}\n${t.transcript}`.toLowerCase();
      const count = haystack.split(lowerQuery).length - 1;
      return { ...t, count };
    })
    .filter((t) => t.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return scored.map((t) => ({
    title: t.title,
    sourceLink: t.sourceLink,
    durationMin: t.durationMin,
    snippet: buildSnippet(t.transcript || t.title, query),
  }));
}

module.exports = { ensureTranscriptsSheet, saveTranscript, getAllTranscripts, searchTranscripts };
