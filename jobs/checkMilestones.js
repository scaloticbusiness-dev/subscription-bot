// jobs/checkMilestones.js
// Runs once a day (alongside the expiration check). For every Active
// subscriber, works out how long they've been a member and, if they've
// just crossed a loyalty milestone (1/3/6/12 months) that hasn't already
// been sent, emails them a small celebratory note and records it on the
// sheet so the same milestone is never sent twice.

const { getAllRows, updateRow } = require('../lib/sheets');
const { sendMilestoneEmail, sendTestimonialRequestEmail } = require('../lib/email');

// Ordered from smallest to largest. `days` is the minimum number of days
// since signup required to have reached this milestone.
const MILESTONES = [
  { days: 30, label: '1 μήνα' },
  { days: 90, label: '3 μήνες' },
  { days: 180, label: '6 μήνες' },
  { days: 365, label: '1 χρόνο' },
];

function daysSince(dateStr) {
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Returns the highest milestone reached given days-since-signup, or null
 * if none reached yet.
 */
function highestMilestoneReached(days) {
  let reached = null;
  for (const m of MILESTONES) {
    if (days >= m.days) reached = m;
  }
  return reached;
}

async function checkMilestones() {
  console.log(`[${new Date().toISOString()}] Running daily milestone check...`);
  const rows = await getAllRows();
  const activeRows = rows.filter((r) => r.status.toLowerCase() === 'active');

  let sentCount = 0;

  for (const row of activeRows) {
    try {
      const days = daysSince(row.date);
      if (days === null) continue;

      const reached = highestMilestoneReached(days);
      if (!reached) continue;
      if (row.lastMilestone === reached.label) continue; // already sent this one

      await sendMilestoneEmail({ name: row.name, email: row.email, milestoneLabel: reached.label });
      if (reached.label === '3 μήνες') {
        await sendTestimonialRequestEmail({ name: row.name, email: row.email });
      }
      await updateRow(row.rowNumber, { lastMilestone: reached.label });
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to process milestone for row ${row.rowNumber} (${row.email}):`, err.message);
    }
  }

  console.log(`Milestone check complete. Sent ${sentCount} milestone email(s).`);
}

module.exports = { checkMilestones };
