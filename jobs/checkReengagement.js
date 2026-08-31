// jobs/checkReengagement.js
// Runs once a day (alongside the other daily checks). For every Active
// subscriber whose Discord activity has gone quiet (no tracked message in
// INACTIVE_THRESHOLD_DAYS, or never tracked at all), sends a friendly DM
// nudge — as long as they haven't been pinged again within
// REPING_INTERVAL_DAYS, so this doesn't nag daily.
//
// This is a Discord DM, not an email — deliberately kept on a separate
// channel/track from the email unsubscribe system, since e-privacy
// marketing-email rules don't govern Discord DMs the same way. If someone
// has DMs from server members disabled, sendDirectMessage just returns
// false (no error) and this silently moves on.

const { getAllRows, updateRow } = require('../lib/sheets');
const { findMemberByUsername, sendDirectMessage } = require('../lib/discord');

const INACTIVE_THRESHOLD_DAYS = 14;
const REPING_INTERVAL_DAYS = 14;

const REENGAGEMENT_MESSAGE = `Γεια σου! 👋

Παρατηρήσαμε ότι δεν έχεις περάσει από το Discord server μας τελευταία. Μη διστάσεις να μπεις όποτε θες — υπάρχει νέο περιεχόμενο και η κοινότητα θα χαρεί να σε δει!

Αν κόλλησες κάπου ή έχεις κάποια απορία, πες μου ελεύθερα εδώ.`;

function daysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkReengagement() {
  console.log(`[${new Date().toISOString()}] Running daily Discord re-engagement check...`);

  const rows = await getAllRows();
  const candidates = rows.filter(
    (r) => r.status.toLowerCase() === 'active' && r.discordUsername
  );

  let sentCount = 0;

  for (const row of candidates) {
    try {
      const lastActiveDays = daysSince(row.discordLastActive);
      const isInactive = lastActiveDays === null || lastActiveDays >= INACTIVE_THRESHOLD_DAYS;
      if (!isInactive) continue;

      const daysSinceLastPing = daysSince(row.lastReengagementSent);
      if (daysSinceLastPing !== null && daysSinceLastPing < REPING_INTERVAL_DAYS) continue;

      const member = await findMemberByUsername(row.discordUsername);
      if (!member?.user?.id) continue; // not currently found in the server

      const sent = await sendDirectMessage(member.user.id, REENGAGEMENT_MESSAGE);
      if (sent) {
        await updateRow(row.rowNumber, { lastReengagementSent: new Date().toISOString().slice(0, 10) });
        sentCount += 1;
      }
    } catch (err) {
      console.error(`Failed to process re-engagement for row ${row.rowNumber} (${row.discordUsername}):`, err.message);
    }
  }

  console.log(`Re-engagement check complete. Sent ${sentCount} DM(s).`);
}

module.exports = { checkReengagement };
