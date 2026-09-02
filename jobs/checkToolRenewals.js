// jobs/checkToolRenewals.js
// Runs once a day (alongside the other daily checks). Reads the "Tool
// Renewals" tab (lib/toolRenewals.js) and:
//   1. Rolls forward any row whose Renewal Date has already passed, by one
//      billing cycle — so a tool only ever needs to be entered once, not
//      re-typed every month/year.
//   2. Collects every row that's due within its own Alert Days Before
//      window and hasn't already been alerted for this specific renewal
//      date, and sends the admin one summary email listing all of them.

const { getAllToolRenewals, updateToolRenewalRow } = require('../lib/toolRenewals');
const { sendToolRenewalAlert } = require('../lib/email');

const DEFAULT_ALERT_DAYS_BEFORE = 7;

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Adds one billing cycle to a YYYY-MM-DD date string and returns the
 * result in the same format. "Yearly" adds a year, anything else
 * (including "Monthly" or blank) adds a month.
 */
function nextRenewalDate(dateStr, billingCycle) {
  const date = new Date(dateStr);
  if ((billingCycle || '').toLowerCase() === 'yearly') {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    date.setMonth(date.getMonth() + 1);
  }
  return date.toISOString().slice(0, 10);
}

async function checkToolRenewals() {
  console.log(`[${new Date().toISOString()}] Running daily tool renewal check...`);
  const rows = await getAllToolRenewals();

  const due = [];

  for (const row of rows) {
    try {
      const days = daysUntil(row.renewalDate);
      if (days === null) {
        console.warn(`Skipping tool renewal row ${row.rowNumber} (${row.tool}): invalid Renewal Date "${row.renewalDate}".`);
        continue;
      }

      if (days < 0) {
        // Already renewed (via its own billing, outside our control) —
        // just roll the tracker forward to the next cycle.
        const next = nextRenewalDate(row.renewalDate, row.billingCycle);
        await updateToolRenewalRow(row.rowNumber, { renewalDate: next, lastAlertSent: '' });
        console.log(`Rolled "${row.tool}" forward to ${next}.`);
        continue;
      }

      const alertDaysBefore = Number(row.alertDaysBefore) || DEFAULT_ALERT_DAYS_BEFORE;
      if (days <= alertDaysBefore && row.lastAlertSent !== row.renewalDate) {
        due.push({
          rowNumber: row.rowNumber,
          tool: row.tool,
          cost: row.cost,
          currency: row.currency,
          renewalDate: row.renewalDate,
          daysUntil: days,
        });
      }
    } catch (err) {
      console.error(`Failed to process tool renewal row ${row.rowNumber} (${row.tool}):`, err.message);
    }
  }

  if (due.length > 0) {
    try {
      await sendToolRenewalAlert({ renewals: due });
      for (const item of due) {
        await updateToolRenewalRow(item.rowNumber, { lastAlertSent: item.renewalDate });
      }
    } catch (err) {
      console.error('Failed to send tool renewal alert:', err.message);
    }
  }

  console.log(`Tool renewal check complete. ${due.length} renewal(s) alerted.`);
}

module.exports = { checkToolRenewals };
