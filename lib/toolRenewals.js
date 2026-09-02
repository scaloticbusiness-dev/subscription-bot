// lib/toolRenewals.js
// Tracks recurring tool/service subscriptions (Railway, Stripe, ManyChat,
// domain renewals, etc.) in their own "Tool Renewals" tab, so there's one
// place that knows what's paid for and when it renews next — instead of
// that living only in someone's inbox full of receipt emails.
//
// Expected columns (row 1 = headers):
// A Tool | B Cost | C Currency | D Billing Cycle | E Renewal Date
// F Alert Days Before | G Last Alert Sent | H Notes
//
// Billing Cycle is either "Monthly" or "Yearly" (case-insensitive). Once a
// Renewal Date has passed, checkToolRenewals (jobs/checkToolRenewals.js)
// rolls it forward by one cycle automatically, so a row only ever needs to
// be entered once — not re-typed every month.

const { google } = require('googleapis');

const TOOL_RENEWALS_SHEET_NAME = 'Tool Renewals';
const HEADER_ROW = ['Tool', 'Cost', 'Currency', 'Billing Cycle', 'Renewal Date', 'Alert Days Before', 'Last Alert Sent', 'Notes'];

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
 * Ensures the "Tool Renewals" tab exists, creating it (with the header
 * row) if it doesn't. Safe to call repeatedly.
 */
async function ensureToolRenewalsSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === TOOL_RENEWALS_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TOOL_RENEWALS_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${TOOL_RENEWALS_SHEET_NAME}!A1:H1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });

  console.log('Created "Tool Renewals" tab.');
}

/**
 * Returns every tool subscription row as an array of objects, each tagged
 * with its 1-based sheet row number (rowNumber) for later updates. Rows
 * with no Tool name are skipped (treated as blank/placeholder rows).
 */
async function getAllToolRenewals() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${TOOL_RENEWALS_SHEET_NAME}!A2:H`,
  });

  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({
      rowNumber: idx + 2, // +2 because data starts at row 2
      tool: row[0] || '',
      cost: row[1] || '',
      currency: row[2] || '',
      billingCycle: row[3] || '',
      renewalDate: row[4] || '',
      alertDaysBefore: row[5] || '',
      lastAlertSent: row[6] || '',
      notes: row[7] || '',
    }))
    .filter((r) => r.tool);
}

/**
 * Updates specific columns of an existing row (1-based sheet row number).
 * `fields` is a partial object, e.g. { renewalDate: '2026-10-01', lastAlertSent: '' }.
 */
async function updateToolRenewalRow(rowNumber, fields) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const columnMap = {
    tool: 'A',
    cost: 'B',
    currency: 'C',
    billingCycle: 'D',
    renewalDate: 'E',
    alertDaysBefore: 'F',
    lastAlertSent: 'G',
    notes: 'H',
  };

  const requests = Object.entries(fields).map(([key, value]) => {
    const col = columnMap[key];
    return {
      range: `${TOOL_RENEWALS_SHEET_NAME}!${col}${rowNumber}`,
      values: [[value]],
    };
  });

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: requests,
    },
  });
}

module.exports = { ensureToolRenewalsSheet, getAllToolRenewals, updateToolRenewalRow };
