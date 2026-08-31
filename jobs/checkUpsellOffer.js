// jobs/checkUpsellOffer.js
// Runs once a day (alongside the other daily checks). For every Active
// Monthly-plan subscriber who signed up UPSELL_AFTER_DAYS+ ago and hasn't
// already received the upsell, sends a one-time "consider going yearly"
// email and marks it sent so it's never repeated.

const { getAllRows, updateRow } = require('../lib/sheets');
const { sendUpsellEmail } = require('../lib/email');

const UPSELL_AFTER_DAYS = 14;

function daysSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkUpsellOffer() {
  console.log(`[${new Date().toISOString()}] Running daily upsell offer job...`);

  const rows = await getAllRows();
  const candidates = rows.filter(
    (r) =>
      r.status.toLowerCase() === 'active' &&
      r.plan &&
      r.plan.includes('Monthly') &&
      r.upsellSent !== 'Yes' &&
      r.unsubscribed !== 'Yes'
  );

  let sentCount = 0;

  for (const row of candidates) {
    try {
      const days = daysSince(row.date);
      if (days === null || days < UPSELL_AFTER_DAYS) continue;

      await sendUpsellEmail({ name: row.name, email: row.email });
      await updateRow(row.rowNumber, { upsellSent: 'Yes' });
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to send upsell email for row ${row.rowNumber} (${row.email}):`, err.message);
    }
  }

  console.log(`Upsell offer job complete. Sent ${sentCount} email(s).`);
}

module.exports = { checkUpsellOffer };
