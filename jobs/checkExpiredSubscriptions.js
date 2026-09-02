// jobs/checkExpiredSubscriptions.js
// Runs once a day. Finds every row where:
//   - Status is "Active"
//   - Renewal Date is today or in the past
// and, for each one: removes the Discord role(s) and marks Status as "Expired".
// This is the ONLY place that removes the Discord role or marks a row
// "Expired" — routes/stripeWebhook.js deliberately leaves both alone when a
// cancellation comes in, so someone who cancels keeps their role/access
// through the period they already paid for, and only loses it here, on
// their actual Renewal Date (whether that's because they cancelled and
// never renewed, or simply didn't renew).
// Afterwards, sends the admin one summary email listing everyone who expired
// today (so they can be manually removed from Skool — no public API for
// that), and sends each of them individually a goodbye email.
const { getAllRows, updateRow } = require('../lib/sheets');
const { findMemberByUsername, removeRoleFromUser } = require('../lib/discord');
const { sendSkoolRemovalAlert, sendGoodbyeEmail } = require('../lib/email');

function isExpired(renewalDateStr) {
  if (!renewalDateStr) return false;
  const renewalDate = new Date(renewalDateStr);
  if (isNaN(renewalDate.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  renewalDate.setHours(0, 0, 0, 0);
  return renewalDate.getTime() <= today.getTime();
}

async function checkExpiredSubscriptions() {
  console.log(`[${new Date().toISOString()}] Running daily expiration check...`);
  const rows = await getAllRows();
  const expiredActive = rows.filter((r) => r.status.toLowerCase() === 'active' && isExpired(r.renewalDate));
  console.log(`Found ${expiredActive.length} expired subscription(s) to process.`);

const processedForSkool = [];

for (const row of expiredActive) {
  try {
    if (row.discordUsername) {
      const member = await findMemberByUsername(row.discordUsername);
      if (member?.user?.id) {
        await removeRoleFromUser(member.user.id);
        console.log(`Removed role from ${row.discordUsername}`);

      // Also remove the VIP role in case they had it (yearly plan) —
      // harmless no-op if they never had it.
      if (process.env.DISCORD_VIP_ROLE_ID) {
        await removeRoleFromUser(member.user.id, process.env.DISCORD_VIP_ROLE_ID);
      }
      } else {
        console.warn(`Could not find Discord member: ${row.discordUsername} (row ${row.rowNumber})`);
      }
    }
    await updateRow(row.rowNumber, {
      status: 'Expired',
      expiredDate: new Date().toISOString().slice(0, 10),
    });
    console.log(`Marked row ${row.rowNumber} (${row.email}) as Expired`);

  try {
    await sendGoodbyeEmail({ name: row.name, email: row.email });
  } catch (err) {
    console.error(`Failed to send goodbye email to ${row.email}:`, err.message);
  }

  processedForSkool.push({ name: row.name, email: row.email, plan: row.plan });
  } catch (err) {
    console.error(`Failed to process row ${row.rowNumber} (${row.email}):`, err.message);
    // Continue with the next row even if one fails.
  }
}

try {
  await sendSkoolRemovalAlert(processedForSkool);
} catch (err) {
  console.error('Failed to send Skool removal alert email:', err.message);
}

console.log('Daily expiration check complete.');
}

module.exports = { checkExpiredSubscriptions, isExpired };
