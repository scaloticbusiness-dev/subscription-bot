// lib/supportTickets.js
// Tracks Discord support tickets (opened via the Ticket Tool bot's "open a
// ticket" button in #tickets) in their own "Support Tickets" tab, so ticket
// response times can be measured and slow ones can be flagged — Ticket Tool
// itself has no SLA/reporting features of its own.
//
// Tickets are tracked purely by watching Discord gateway events for the
// configured category (TICKET_CATEGORY_ID) — see lib/discordGateway.js:
//   - channelCreate under that category  -> new row (Opened At)
//   - first message from someone with TICKET_SUPPORT_ROLE_ID in that
//     channel -> First Response At
//   - channelDelete under that category  -> Closed At
//
// Expected columns (row 1 = headers):
// A Channel ID | B Channel Name | C Opened At | D First Response At
// E Closed At | F Alert Sent

const { google } = require('googleapis');

const SUPPORT_TICKETS_SHEET_NAME = 'Support Tickets';
const HEADER_ROW = ['Channel ID', 'Channel Name', 'Opened At', 'First Response At', 'Closed At', 'Alert Sent'];

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
 * Ensures the "Support Tickets" tab exists, creating it (with the header
 * row) if it doesn't. Safe to call repeatedly.
 */
async function ensureSupportTicketsSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === SUPPORT_TICKETS_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SUPPORT_TICKETS_SHEET_NAME } } }] },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUPPORT_TICKETS_SHEET_NAME}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER_ROW] },
  });

  console.log('Created "Support Tickets" tab.');
}

/**
 * Records a newly-opened ticket channel.
 */
async function addTicket({ channelId, channelName, openedAt }) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${SUPPORT_TICKETS_SHEET_NAME}!A:F`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[channelId, channelName || '', openedAt, '', '', '']] },
  });
}

/**
 * Returns every tracked ticket as an array of objects, each tagged with its
 * 1-based sheet row number (rowNumber) for later updates.
 */
async function getAllTickets() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SUPPORT_TICKETS_SHEET_NAME}!A2:F`,
  });

  const rows = res.data.values || [];
  return rows
    .map((row, idx) => ({
      rowNumber: idx + 2,
      channelId: row[0] || '',
      channelName: row[1] || '',
      openedAt: row[2] || '',
      firstResponseAt: row[3] || '',
      closedAt: row[4] || '',
      alertSent: row[5] || '',
    }))
    .filter((r) => r.channelId);
}

/**
 * Finds a tracked ticket by its Discord channel ID, or null if this
 * channel isn't being tracked (e.g. it was created before TICKET_CATEGORY_ID
 * was configured).
 */
async function findTicketByChannelId(channelId) {
  const tickets = await getAllTickets();
  return tickets.find((t) => t.channelId === channelId) || null;
}

/**
 * Updates specific columns of an existing row (1-based sheet row number).
 * `fields` is a partial object, e.g. { firstResponseAt: '2026-09-02T10:00:00.000Z' }.
 */
async function updateTicketRow(rowNumber, fields) {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const columnMap = {
    channelId: 'A',
    channelName: 'B',
    openedAt: 'C',
    firstResponseAt: 'D',
    closedAt: 'E',
    alertSent: 'F',
  };

  const requests = Object.entries(fields).map(([key, value]) => ({
    range: `${SUPPORT_TICKETS_SHEET_NAME}!${columnMap[key]}${rowNumber}`,
    values: [[value]],
  }));

  if (requests.length === 0) return;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data: requests },
  });
}

module.exports = { ensureSupportTicketsSheet, addTicket, getAllTickets, findTicketByChannelId, updateTicketRow };
