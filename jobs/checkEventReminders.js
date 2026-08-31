// jobs/checkEventReminders.js
// Runs frequently (every 5 minutes, for enough precision on the 10-minute
// reminder). Reads the "Events" tab and sends a reminder — posted to
// EVENT_REMINDER_CHANNEL_ID on Discord, and emailed to the admin as a
// backup record — at 24h, 1h, and 10min before each event's DateTime.
// Each reminder is tracked independently (not sequential/else-if) so a
// bot restart never silently skips one — if the bot was down and comes
// back past a threshold, it sends the catch-up reminder immediately
// rather than losing it.

const { getAllEvents, markReminderSent, ensureEventsSheet } = require('../lib/events');
const { sendEventReminderEmail } = require('../lib/email');
const { sendChannelMessage } = require('../lib/discord');

const THRESHOLDS = [
  { key: 'reminder24hSent', maxMinutes: 24 * 60, label: '24 ώρες' },
  { key: 'reminder1hSent', maxMinutes: 60, label: '1 ώρα' },
  { key: 'reminder10minSent', maxMinutes: 10, label: '10 λεπτά' },
];

async function checkEventReminders() {
  console.log(`[${new Date().toISOString()}] Running event reminders check...`);

  try {
    await ensureEventsSheet();
  } catch (err) {
    console.error('Could not verify/create the Events tab:', err.message);
    return;
  }

  const events = await getAllEvents();
  const now = Date.now();
  let sentCount = 0;

  for (const event of events) {
    const eventTime = new Date(event.dateTime).getTime();
    if (isNaN(eventTime)) {
      console.warn(`Event "${event.name}" has an unparseable DateTime "${event.dateTime}" — skipping.`);
      continue;
    }

    const minutesUntil = (eventTime - now) / 60000;
    if (minutesUntil < -60) continue; // event long past, nothing to do

    for (const threshold of THRESHOLDS) {
      if (event[threshold.key]) continue; // already sent
      if (minutesUntil > threshold.maxMinutes) continue; // not time yet
      if (minutesUntil < -10) continue; // way too late for this specific threshold, skip quietly

      try {
        const channelId = process.env.EVENT_REMINDER_CHANNEL_ID;
        if (channelId) {
          const text = `⏰ **Υπενθύμιση: "${event.name}" ξεκινάει σε ${threshold.label}!**\n${event.description || ''}${event.link ? `\n👉 ${event.link}` : ''}`;
          await sendChannelMessage(channelId, text);
        }
        await sendEventReminderEmail({
          eventName: event.name,
          label: threshold.label,
          dateTime: event.dateTime,
          description: event.description,
          link: event.link,
        });
        await markReminderSent(event.rowNumber, threshold.key);
        sentCount += 1;
      } catch (err) {
        console.error(`Failed to send ${threshold.label} reminder for "${event.name}":`, err.message);
      }
    }
  }

  console.log(`Event reminders check complete. Sent ${sentCount} reminder(s).`);
}

module.exports = { checkEventReminders };
