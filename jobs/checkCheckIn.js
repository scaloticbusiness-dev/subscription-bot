// jobs/checkCheckIn.js
// Runs once a day (alongside the other daily checks). For every Active
// subscriber who signed up 3-4 days ago and hasn't already received a
// check-in email, sends a friendly "how's it going?" note and marks it
// sent so it's never repeated. A narrow 3-4 day window (rather than
// "3+ days") keeps this from silently re-triggering for older rows if the
// job is ever paused for a few days.

const { getAllRows, updateRow } = require('../lib/sheets');
const { sendCheckInEmail } = require('../lib/email');

const CHECK_IN_MIN_DAYS = 3;
const CHECK_IN_MAX_DAYS = 4;

function daysSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkCheckIn() {
  console.log(`[${new Date().toISOString()}] Running daily check-in email job...`);
  const rows = await getAllRows();
  const candidates = rows.filter(
    (r) => r.status.toLowerCase() === 'active' && r.checkinSent !== 'Yes' && r.unsubscribed !== 'Yes'
  );

  let sentCount = 0;

  for (const row of candidates) {
    try {
      const days = daysSince(row.date);
      if (days === null || days < CHECK_IN_MIN_DAYS || days > CHECK_IN_MAX_DAYS) continue;

      await sendCheckInEmail({ name: row.name, email: row.email });
      await updateRow(row.rowNumber, { checkinSent: 'Yes' });
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to send check-in email for row ${row.rowNumber} (${row.email}):`, err.message);
    }
  }

  console.log(`Check-in email job complete. Sent ${sentCount} email(s).`);
}

module.exports = { checkCheckIn };
