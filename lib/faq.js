// lib/faq.js
// Reads keyword -> answer pairs from a "FAQ" tab in the main spreadsheet
// (same spreadsheet as the subscriber sheet, GOOGLE_SHEET_ID — just a
// different tab so it's easy for the admin to edit without touching code).
// Expected columns: A Keywords (comma-separated) | B Answer.
//
// Cached in memory for a few minutes since this gets checked on every
// message in the configured support channel — re-reading the sheet on
// every single message would be wasteful and slow.

const { google } = require('googleapis');

const FAQ_SHEET_NAME = 'FAQ';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let sheetsClient = null;
let cachedFaqs = null;
let cacheTimestamp = 0;

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
 * Loads (and caches) the FAQ list. Returns an empty array — not an error —
 * if the "FAQ" tab doesn't exist yet, so the bot just quietly does nothing
 * until the admin creates it.
 */
async function loadFaqs() {
  const now = Date.now();
  if (cachedFaqs && now - cacheTimestamp < CACHE_TTL_MS) return cachedFaqs;

  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${FAQ_SHEET_NAME}!A2:B`,
    });
  } catch (err) {
    console.warn('Could not read the "FAQ" tab (has it been created yet?):', err.message);
    cachedFaqs = [];
    cacheTimestamp = now;
    return cachedFaqs;
  }

  const rows = res.data.values || [];
  cachedFaqs = rows
    .filter((r) => r[0] && r[1])
    .map((r) => ({
      keywords: r[0].split(',').map((k) => k.trim().toLowerCase()).filter(Boolean),
      answer: r[1],
    }));
  cacheTimestamp = now;
  return cachedFaqs;
}

/**
 * Finds the first FAQ entry with a keyword that appears anywhere in the
 * given message text (case-insensitive substring match). Returns null if
 * nothing matches.
 */
function findMatch(messageText, faqs) {
  const lower = (messageText || '').toLowerCase();
  return faqs.find((faq) => faq.keywords.some((kw) => lower.includes(kw))) || null;
}

/**
 * Ensures the "FAQ" tab exists in the main spreadsheet, creating it with a
 * header row and a couple of starter example rows if it doesn't. Safe to
 * call on every startup — does nothing if the tab already exists.
 */
async function ensureFaqSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === FAQ_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: FAQ_SHEET_NAME } } }],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${FAQ_SHEET_NAME}!A1:B3`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [
        ['Keywords', 'Answer'],
        ['τιμη, κοστος, πληρωνω', 'Η τιμή είναι διαθέσιμη στο site μας — δες lotik.gr για λεπτομέρειες!'],
        ['ρολο, role, discord', 'Ο ρόλος σου ενεργοποιείται αυτόματα μέσα σε λίγα λεπτά μετά την πληρωμή.'],
      ],
    },
  });

  console.log('Created "FAQ" tab with starter example rows.');
}

module.exports = { loadFaqs, findMatch, ensureFaqSheet };
