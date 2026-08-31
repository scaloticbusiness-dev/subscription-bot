// jobs/checkWinBack.js
// Runs once a day. For every Expired subscriber whose subscription ended
// about 30 days ago (and who hasn't already received a win-back email),
// sends a "we miss you" email and marks it as sent so it's never repeated.

const { getAllRows, updateRow } = require('../lib/sheets');
const { sendWinBackEmail } = require('../lib/email');

const WIN_BACK_DAYS = 30;

function daysSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkWinBack() {
  console.log(`[${new Date().toISOString()}] Running daily win-back check...`);
  const rows = await getAllRows();
  const candidates = rows.filter(
    (r) =>
      r.status.toLowerCase() === 'expired' &&
      r.expiredDate &&
      r.winBackSent !== 'Yes' &&
      r.unsubscribed !== 'Yes'
  );

  let sentCount = 0;

  for (const row of candidates) {
    try {
      const days = daysSince(row.expiredDate);
      if (days === null || days < WIN_BACK_DAYS) continue;

      await sendWinBackEmail({ name: row.name, email: row.email });
      await updateRow(row.rowNumber, { winBackSent: 'Yes' });
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to process win-back for row ${row.rowNumber} (${row.email}):`, err.message);
    }
  }

  console.log(`Win-back check complete. Sent ${sentCount} email(s).`);
}

module.exports = { checkWinBack };
