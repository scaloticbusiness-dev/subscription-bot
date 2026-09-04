// jobs/sendLaunchAnnouncement.js
// NOT scheduled automatically. Triggered manually by visiting
// /send-launch-announcement once the course/Skool community is actually
// ready. Sends the "course is live!" email to every lead who hasn't
// already received it — safe to call more than once, since it only emails
// people not yet marked as sent (e.g. if new leads came in since the last
// time you triggered it).

const { ensureTrackingColumns, getAllLeads, markLeadField } = require('../lib/leads');
const { sendLaunchAnnouncementEmail } = require('../lib/email');

// Resend accepts 2 requests a second. The loop below used to send as fast
// as it could, so most of a 60-lead run came back rate-limited and those
// people silently went unsent. One send every 600ms stays inside the
// limit and still finishes 200 leads in about two minutes.
const SEND_INTERVAL_MS = 600;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendLaunchAnnouncementToAllLeads() {
  console.log(`[${new Date().toISOString()}] Sending launch announcement to leads...`);

  if (!process.env.GOOGLE_LEADS_SHEET_ID) {
    console.warn('GOOGLE_LEADS_SHEET_ID not set — nothing to do.');
    return 0;
  }

  const { launchCol } = await ensureTrackingColumns();
  const leads = await getAllLeads();

  let sentCount = 0;
  // The form lets the same person apply twice, and the sheet keeps both
  // rows. Without this, they get the launch email twice.
  const emailsSent = new Set();

  for (const lead of leads) {
    if (!lead.email || lead.launchSent === 'Yes' || lead.unsubscribed === 'Yes') continue;

    const key = lead.email.trim().toLowerCase();
    if (emailsSent.has(key)) {
      await markLeadField(lead.rowNumber, launchCol, 'Yes');
      console.log(`Row ${lead.rowNumber} is a duplicate of ${key} — marked sent without emailing again.`);
      continue;
    }

    try {
      await sendLaunchAnnouncementEmail({ firstName: lead.firstName, email: lead.email });
      await markLeadField(lead.rowNumber, launchCol, 'Yes');
      emailsSent.add(key);
      sentCount += 1;
      await wait(SEND_INTERVAL_MS);
    } catch (err) {
      console.error(`Failed to send launch announcement for row ${lead.rowNumber} (${lead.email}):`, err.message);
    }
  }

  console.log(`Launch announcement complete. Sent to ${sentCount} lead(s).`);
  return sentCount;
}

module.exports = { sendLaunchAnnouncementToAllLeads };
