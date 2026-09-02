// lib/expenses.js
// Tracks one-off/manual business expenses (ad spend, contractor payments,
// misc purchases — anything that isn't a recurring tool subscription,
// which already has its own tracker in lib/toolRenewals.js) in their own
// "Expenses" tab, logged via the /log-expense slash command.
//
// Expected columns (row 1 = headers):
// A Date | B Category | C Description | D Amount | E Currency | F Logged By

const { google } = require('googleapis');

const EXPENSES_SHEET_NAME = 'Expenses';
const HEADER_ROW = ['Date', 'Category', 'Description', 'Amount', 'Currency', 'Logged By'];

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
 * Ensures the "Expenses" tab exists, creating it with headers if it
 * doesn't. Safe to call repeatedly.
 */
async function ensureExpensesSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === EXPENSES_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: EXPENSES_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${EXPENSES_SHEET_NAME}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });

  console.log('Created "Expenses" tab.');
}

/**
 * Appends one expense as a new row. `date` is a YYYY-MM-DD string.
 */
async function addExpense({ date, category, description, amount, currency, loggedBy }) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${EXPENSES_SHEET_NAME}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[date, category || '', description || '', amount, currency || 'EUR', loggedBy || '']],
    },
  });
}

/**
 * Returns every logged expense as an array of objects.
 */
async function getAllExpenses() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${EXPENSES_SHEET_NAME}!A2:F`,
    });
  } catch (err) {
    console.warn('Could not read the "Expenses" tab (has it been created yet?):', err.message);
    return [];
  }

  const rows = res.data.values || [];
  return rows
    .filter((r) => r[0]) // needs at least a date
    .map((r) => ({
      date: r[0] || '',
      category: r[1] || '',
      description: r[2] || '',
      amount: r[3] || '',
      currency: r[4] || 'EUR',
      loggedBy: r[5] || '',
    }));
}

/**
 * Returns the [start, end) YYYY-MM-DD range for the calendar month that is
 * `monthsAgo` months before the current one. monthsAgo=0 means "this
 * month, to date".
 */
function monthRange(monthsAgo) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  return {
    startStr: start.toISOString().slice(0, 10),
    endStr: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString('el-GR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

/**
 * Returns manually-logged expenses for the given month (monthsAgo=0 is the
 * current month, to date), grouped by currency and category. Shape:
 * { expenses, label, totalsByCurrency: { EUR: 123.45 }, byCategory: { EUR: { Ads: 50 } } }
 */
async function getExpensesForMonth(monthsAgo = 0) {
  const { startStr, endStr, label } = monthRange(monthsAgo);
  const all = await getAllExpenses();
  const expenses = all.filter((e) => e.date >= startStr && e.date < endStr);

  const totalsByCurrency = {};
  const byCategory = {};

  for (const e of expenses) {
    const amt = parseFloat(e.amount) || 0;
    const cur = e.currency || 'EUR';
    totalsByCurrency[cur] = (totalsByCurrency[cur] || 0) + amt;
    byCategory[cur] = byCategory[cur] || {};
    const cat = e.category || 'Χωρίς κατηγορία';
    byCategory[cur][cat] = (byCategory[cur][cat] || 0) + amt;
  }

  return { expenses, label, totalsByCurrency, byCategory };
}

/**
 * Formats an amount in a given currency for display in Discord messages.
 * EUR gets the trailing € symbol (matching the rest of the bot's Greek
 * messages); anything else gets a trailing currency code.
 */
function formatMoney(amount, currency) {
  const rounded = (Math.round((amount + Number.EPSILON) * 100) / 100).toFixed(2);
  return currency === 'EUR' ? `${rounded}€` : `${rounded} ${currency}`;
}

module.exports = { ensureExpensesSheet, addExpense, getAllExpenses, getExpensesForMonth, formatMoney };
