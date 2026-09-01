// jobs/checkEventWrapup.js
// Runs every 15 minutes. For each event in the "Events" tab whose 90-minute
// window has just ended (and hasn't been wrapped up yet), looks up who
// attended via the Attendance Log and gives them the ENGAGED_ROLE_ID
// Discord role, if that env var is configured. No-op (but still marks
// wrapped-up) if the role isn't configured — avoids reprocessing the same
// event forever.

const { getAllEvents, markReminderSent, ensureEventsSheet } = require('../lib/events');
const { getAttendeesInWindow } = require('../lib/attendance');
const { findMemberByUsername, addRoleToUser } = require('../lib/discord');

const EVENT_DEFAULT_DURATION_MS = 90 * 60 * 1000;
const WRAPUP_GRACE_WINDOW_MS = 30 * 60 * 1000; // process within 30 min of event ending

async function checkEventWrapup() {
  console.log(`[${new Date().toISOString()}] Running event wrap-up check...`);

  try {
    await ensureEventsSheet();
  } catch (err) {
    console.error('Could not verify/create the Events tab:', err.message);
    return;
  }

  const events = await getAllEvents();
  const now = Date.now();
  let taggedCount = 0;

  for (const event of events) {
    if (event.wrapupProcessed) continue;

    const startTime = new Date(event.dateTime).getTime();
    if (isNaN(startTime)) continue;
    const endTime = startTime + EVENT_DEFAULT_DURATION_MS;

    // Only process shortly after the event window ends — not too early
    // (event still running) and not indefinitely late.
    if (now < endTime) continue;
    if (now > endTime + WRAPUP_GRACE_WINDOW_MS) {
      // Missed the window (e.g. bot was down) — mark processed anyway so
      // it doesn't get retried forever with stale data.
      await markReminderSent(event.rowNumber, 'wrapupProcessed');
      continue;
    }

    const engagedRoleId = process.env.ENGAGED_ROLE_ID;
    if (!engagedRoleId) {
      await markReminderSent(event.rowNumber, 'wrapupProcessed');
      continue;
    }

    try {
      const attendees = await getAttendeesInWindow(
        new Date(startTime).toISOString(),
        new Date(endTime).toISOString()
      );

      for (const username of attendees) {
        try {
          const member = await findMemberByUsername(username);
          if (member?.user?.id) {
            await addRoleToUser(member.user.id, engagedRoleId);
            taggedCount += 1;
          }
        } catch (err) {
          console.error(`Failed to tag engaged member ${username}:`, err.message);
        }
      }

      await markReminderSent(event.rowNumber, 'wrapupProcessed');
      console.log(`Wrapped up "${event.name}": tagged ${attendees.size} attendee(s).`);
    } catch (err) {
      console.error(`Failed to wrap up event "${event.name}":`, err.message);
    }
  }

  console.log(`Event wrap-up check complete. Tagged ${taggedCount} member(s) total.`);
}

module.exports = { checkEventWrapup };
