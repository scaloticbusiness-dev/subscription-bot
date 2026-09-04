// jobs/checkRenewalReminders.js
// Runs once a day. Warns Active subscribers a few days before their card is
// charged again. This is the cheapest chargeback prevention there is: almost
// every "I didn't know I was still subscribed" dispute is a renewal that
// arrived unannounced.
//
// "Sent" is tracked by storing the renewal date the reminder was sent for,
// not a Yes/No flag. When the subscription renews, the Renewal Date moves
// forward, stops matching what we stored, and the next cycle gets its own
// reminder — no flag to reset, no reminder sent twice for the same charge.

const { getAllRows, updateRow } = require('../lib/sheets');
const { sendRenewalReminderEmail } = require('../lib/email');

const REMINDER_DAYS_BEFORE = Number(process.env.RENEWAL_REMINDER_DAYS || 3);

function daysUntil(dateStr) {
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkRenewalReminders() {
  console.log(`[${new Date().toISOString()}] Running daily renewal reminder check...`);

  const rows = await getAllRows();
  const candidates = rows.filter(
    (r) =>
      r.status.toLowerCase() === 'active' &&
      r.renewalDate &&
      r.unsubscribed !== 'Yes' &&
      r.renewalReminderSent !== r.renewalDate
  );

  let sentCount = 0;

  for (const row of candidates) {
    try {
      const days = daysUntil(row.renewalDate);
      if (days === null) continue;

      // Only the window that still leaves time to act. A reminder that lands
      // the morning of the charge, or after it, is worse than none.
      if (days > REMINDER_DAYS_BEFORE || days < 1) continue;

      await sendRenewalReminderEmail({
        name: row.name,
        email: row.email,
        amount: row.amount,
        renewalDate: row.renewalDate,
        plan: row.plan,
      });
      await updateRow(row.rowNumber, { renewalReminderSent: row.renewalDate });
      sentCount += 1;
    } catch (err) {
      console.error(
        `Failed to send renewal reminder for row ${row.rowNumber} (${row.email}):`,
        err.message
      );
    }
  }

  console.log(`Renewal reminder check complete. Sent ${sentCount} email(s).`);
}

module.exports = { checkRenewalReminders };
