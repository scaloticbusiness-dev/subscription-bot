// lib/leads.js
// Reads/writes the leads sheet (form submissions from lotik.gr). Unlike
// lib/sheets.js, this reads the header row dynamically instead of assuming
// fixed columns — the form's own columns (Ημερομηνία, Όνομα, Email, etc.)
// stay untouched; we only append tracking columns at the end.

const { google } = require('googleapis');

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

function spreadsheetId() {
    return process.env.GOOGLE_LEADS_SHEET_ID;
}

function sheetName() {
    return process.env.GOOGLE_LEADS_SHEET_NAME || 'Αιτήσεις';
}

/**
 * Converts a 0-based column index to a spreadsheet column letter (A, B, ...
 * Z, AA, AB, ...). The form has well under 26 columns, but this is safe
 * either way.
 */
function colLetter(index) {
    let letter = '';
    let n = index;
    do {
          letter = String.fromCharCode(65 + (n % 26)) + letter;
          n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return letter;
}

async function getHeaders() {
    const sheets = await getClient();
    const res = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId(),
          range: `${sheetName()}!A1:Z1`,
    });
    return res.data.values?.[0] || [];
}

/**
 * Looks up the column letter for a given header name, or null if it's not
 * found. Useful for writing back to a column the form itself created
 * (e.g. "Τηλέφωνο") without hardcoding its position.
 */
async function getColumnLetter(headerName) {
    const headers = await getHeaders();
    const idx = headers.indexOf(headerName);
    return idx >= 0 ? colLetter(idx) : null;
}

/**
 * Ensures our tracking columns exist at the end of the header row, without
 * touching any of the form's own columns. Safe to call repeatedly. Returns
 * the column letters actually used for each.
 */
async function ensureTrackingColumns() {
    const headers = await getHeaders();
    const trackingNames = ['Auto Reply Sent', 'Nurture Sent', 'Launch Email Sent', 'Spam Flagged', 'AB Variant', 'Unsubscribed'];
    const workingHeaders = [...headers];
    const updates = [];
    const result = {};

  const keyForName = {
        'Auto Reply Sent': 'autoReplyCol',
        'Nurture Sent': 'nurtureCol',
        'Launch Email Sent': 'launchCol',
        'Spam Flagged': 'spamCol',
        'AB Variant': 'abVariantCol',
        'Unsubscribed': 'unsubscribedCol',
  };

  for (const name of trackingNames) {
        let idx = workingHeaders.indexOf(name);
        if (idx === -1) {
                idx = workingHeaders.length;
                updates.push({ range: `${sheetName()}!${colLetter(idx)}1`, values: [[name]] });
                workingHeaders.push(name);
        }
        result[keyForName[name]] = colLetter(idx);
  }

  if (updates.length > 0) {
        const sheets = await getClient();
        await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: spreadsheetId(),
                requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
        });
  }

  return result;
}

/**
 * Appends a new lead row, matching it to the sheet's existing header
 * columns dynamically (same approach as everything else in this file) so
 * a lead coming in from outside the lotik.gr form — e.g. via the
 * ManyChat/Instagram DM webhook (see routes/manychatWebhook.js) — lands
 * in the exact same columns the form itself would use, leaving any
 * column this source doesn't have data for blank rather than
 * misaligning the row.
 *
 * Writes to an explicit, computed row/range (values.update) rather than
 * using the Sheets values.append API's automatic "find the table and
 * append below it" behavior. That auto-detection turned out to be
 * unreliable on this sheet: because different rows have different
 * trailing columns populated (e.g. the "AB Variant"/"Unsubscribed"
 * tracking columns are blank on most rows), append() was observed to
 * anchor the new row many columns to the right of column A instead of
 * at A — silently misplacing the lead so it became invisible to
 * getAllLeads/findLeadsByEmail (GDPR export/delete, nurture emails, the
 * weekly leads report) even though the write itself "succeeded". Reading
 * column A to find the next empty row and writing to an explicit range
 * avoids that ambiguity entirely.
 */
async function appendLead({ date, firstName, lastName, email, phone, page }) {
    const headers = await getHeaders();
    const dateIdx = headers.indexOf('Ημερομηνία');
    const firstNameIdx = headers.indexOf('Όνομα');
    const lastNameIdx = headers.indexOf('Επώνυμο');
    const emailIdx = headers.indexOf('Email');
    const phoneIdx = headers.indexOf('Τηλέφωνο');
    const pageIdx = headers.indexOf('Σελίδα');

  const row = new Array(headers.length).fill('');
    if (dateIdx >= 0) row[dateIdx] = date || new Date().toISOString().slice(0, 10);
    if (firstNameIdx >= 0) row[firstNameIdx] = firstName || '';
    if (lastNameIdx >= 0) row[lastNameIdx] = lastName || '';
    if (emailIdx >= 0) row[emailIdx] = email || '';
    if (phoneIdx >= 0) row[phoneIdx] = phone || '';
    if (pageIdx >= 0) row[pageIdx] = page || '';

  const lastColIndex = Math.max(headers.length - 1, 0);
    const lastCol = colLetter(lastColIndex);

  const sheets = await getClient();
    const colA = await sheets.spreadsheets.values.get({
          spreadsheetId: spreadsheetId(),
          range: `${sheetName()}!A:A`,
    });
    const nextRow = (colA.data.values || []).length + 1;

  await sheets.spreadsheets.values.update({
        spreadsheetId: spreadsheetId(),
        range: `${sheetName()}!A${nextRow}:${lastCol}${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
  });
}

/**
 * Returns all lead rows, using the header row to find the relevant columns
 * (Ημερομηνία, Όνομα, Email, Τηλέφωνο, plus the tracking columns) wherever
 * they happen to be, rather than assuming fixed positions.
 */
async function getAllLeads() {
    const sheets = await getClient();
    const headers = await getHeaders();

  const dateIdx = headers.indexOf('Ημερομηνία');
    const firstNameIdx = headers.indexOf('Όνομα');
    const lastNameIdx = headers.indexOf('Επώνυμο');
    const emailIdx = headers.indexOf('Email');
    const phoneIdx = headers.indexOf('Τηλέφωνο');
    const obstacleIdx = headers.indexOf('2 — Μεγαλύτερο εμπόδιο');
    const pageIdx = headers.indexOf('Σελίδα');
    const autoReplyIdx = headers.indexOf('Auto Reply Sent');
    const nurtureIdx = headers.indexOf('Nurture Sent');
    const launchIdx = headers.indexOf('Launch Email Sent');
    const spamIdx = headers.indexOf('Spam Flagged');
    const abVariantIdx = headers.indexOf('AB Variant');
    const unsubscribedIdx = headers.indexOf('Unsubscribed');

  const lastColIndex = Math.max(headers.length - 1, 0);
    const lastCol = colLetter(lastColIndex);

  const res = await sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId(),
        range: `${sheetName()}!A2:${lastCol}`,
  });

  const rows = res.data.values || [];
    return rows.map((row, idx) => ({
          rowNumber: idx + 2,
          date: dateIdx >= 0 ? row[dateIdx] || '' : '',
          firstName: firstNameIdx >= 0 ? row[firstNameIdx] || '' : '',
          lastName: lastNameIdx >= 0 ? row[lastNameIdx] || '' : '',
          email: emailIdx >= 0 ? row[emailIdx] || '' : '',
          phone: phoneIdx >= 0 ? row[phoneIdx] || '' : '',
          obstacle: obstacleIdx >= 0 ? row[obstacleIdx] || '' : '',
          page: pageIdx >= 0 ? row[pageIdx] || '' : '',
          autoReplySent: autoReplyIdx >= 0 ? row[autoReplyIdx] || '' : '',
          nurtureSent: nurtureIdx >= 0 ? row[nurtureIdx] || '' : '',
          launchSent: launchIdx >= 0 ? row[launchIdx] || '' : '',
          spamFlagged: spamIdx >= 0 ? row[spamIdx] || '' : '',
          abVariant: abVariantIdx >= 0 ? row[abVariantIdx] || '' : '',
          unsubscribed: unsubscribedIdx >= 0 ? row[unsubscribedIdx] || '' : '',
    }));
}

/**
 * Writes a single value into a specific column (by letter) for a given row.
 */
async function markLeadField(rowNumber, columnLetter, value) {
    const sheets = await getClient();
    await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId(),
          range: `${sheetName()}!${columnLetter}${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[value]] },
    });
}

/**
 * Returns every lead row matching the given email (case-insensitive) — a
 * person could in theory have submitted the form more than once. Used by
 * the GDPR export endpoint.
 */
async function findLeadsByEmail(email) {
    const leads = await getAllLeads();
    return leads.filter((l) => l.email && l.email.toLowerCase() === (email || '').toLowerCase());
}

/**
 * Marks every lead row matching the given email as unsubscribed. Returns
 * how many rows were updated (0 if the email has no leads at all).
 */
async function markLeadsUnsubscribed(email) {
    const { unsubscribedCol } = await ensureTrackingColumns();
    if (!unsubscribedCol) return 0;

  const matches = await findLeadsByEmail(email);
    for (const lead of matches) {
          await markLeadField(lead.rowNumber, unsubscribedCol, 'Yes');
    }
    return matches.length;
}

/**
 * Redacts the personal fields (first/last name, email, phone) of every
 * lead row matching the given email — used for GDPR erasure requests.
 * Overwrites the fields in place rather than deleting the row/dimension:
 * this sheet is the live Google Form response sheet from lotik.gr, not
 * fully ours to restructure, and a structural row delete here risks
 * desyncing row indices with the form's own tracking. Blanking the
 * identifying fields satisfies "erase my data" without that risk. Returns
 * how many rows were redacted (0 if the email has no leads at all).
 */
async function redactLeadsByEmail(email) {
    const headers = await getHeaders();
    const firstNameIdx = headers.indexOf('Όνομα');
    const lastNameIdx = headers.indexOf('Επώνυμο');
    const emailIdx = headers.indexOf('Email');
    const phoneIdx = headers.indexOf('Τηλέφωνο');

  const matches = await findLeadsByEmail(email);
    if (matches.length === 0) return 0;

  const data = [];
    for (const lead of matches) {
          if (firstNameIdx >= 0) data.push({ range: `${sheetName()}!${colLetter(firstNameIdx)}${lead.rowNumber}`, values: [['[Deleted - GDPR]']] });
          if (lastNameIdx >= 0) data.push({ range: `${sheetName()}!${colLetter(lastNameIdx)}${lead.rowNumber}`, values: [['']] });
          if (emailIdx >= 0) data.push({ range: `${sheetName()}!${colLetter(emailIdx)}${lead.rowNumber}`, values: [['[deleted]']] });
          if (phoneIdx >= 0) data.push({ range: `${sheetName()}!${colLetter(phoneIdx)}${lead.rowNumber}`, values: [['']] });
    }

  if (data.length > 0) {
        const sheets = await getClient();
        await sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: spreadsheetId(),
                requestBody: { valueInputOption: 'USER_ENTERED', data },
        });
  }

  return matches.length;
}

module.exports = {
    ensureTrackingColumns,
    getAllLeads,
    findLeadsByEmail,
    markLeadsUnsubscribed,
    markLeadField,
    getColumnLetter,
    colLetter,
    redactLeadsByEmail,
    appendLead,
};
