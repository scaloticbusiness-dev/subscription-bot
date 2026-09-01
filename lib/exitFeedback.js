// lib/exitFeedback.js
// Logs why a subscriber cancelled, when Stripe hands us a reason. Stripe's
// Customer Portal has an optional "ask for a cancellation reason" feature
// (Settings > Customer Portal > Cancellations) — once enabled there, every
// `customer.subscription.deleted` event includes `cancellation_details`
// with a `reason` (one of a fixed list: too_expensive, missing_features,
// switched_service, unused, customer_service, low_quality, other) and an
// optional free-text `feedback`. This module just records whatever Stripe
// gives us; it does not collect anything itself.

const { google } = require('googleapis');

const EXIT_FEEDBACK_SHEET_NAME = 'Exit Feedback';

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

async function ensureExitFeedbackSheet() {
const sheets = await getClient();
const spreadsheetId = process.env.GOOGLE_SHEET_ID;

const meta = await sheets.spreadsheets.get({ spreadsheetId });
const existing = meta.data.sheets.find((s) => s.properties.title === EXIT_FEEDBACK_SHEET_NAME);
if (existing) return;

await sheets.spreadsheets.batchUpdate({
spreadsheetId,
requestBody: { requests: [{ addSheet: { properties: { title: EXIT_FEEDBACK_SHEET_NAME } } }] },
});

await sheets.spreadsheets.values.update({
spreadsheetId,
range: `${EXIT_FEEDBACK_SHEET_NAME}!A1:E1`,
valueInputOption: 'USER_ENTERED',
requestBody: { values: [['Date', 'Name', 'Email', 'Reason', 'Feedback']] },
});

console.log('Created "Exit Feedback" tab.');
}

/**
* Logs one cancellation's reason/feedback. Safe no-op-ish if reason and
* feedback are both empty (Stripe's portal cancellation-reason feature
* isn't enabled yet, or the customer skipped it) — still logs the row so
* the sheet reflects every cancellation, just with blank reason columns.
*/
async function logExitFeedback({ name, email, reason, feedback }) {
const sheets = await getClient();
await sheets.spreadsheets.values.append({
spreadsheetId: process.env.GOOGLE_SHEET_ID,
range: `${EXIT_FEEDBACK_SHEET_NAME}!A:E`,
valueInputOption: 'USER_ENTERED',
requestBody: {
values: [[new Date().toISOString().slice(0, 10), name || '', email || '', reason || '', feedback || '']],
},
});
}

module.exports = { ensureExitFeedbackSheet, logExitFeedback };
