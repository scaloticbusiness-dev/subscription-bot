// jobs/sendLaunchAnnouncement.js
// NOT scheduled automatically. Triggered manually by visiting
// /send-launch-announcement once the course/Skool community is actually
// ready. Sends the "course is live!" email to every lead who hasn't
// already received it — safe to call more than once, since it only emails
// people not yet marked as sent (e.g. if new leads came in since the last
// time you triggered it).

const { ensureTrackingColumns, getAllLeads, markLeadField } = require('../lib/leads');
const { sendLaunchAnnouncementEmail } = require('../lib/email');

async function sendLaunchAnnouncementToAllLeads() {
  console.log(`[${new Date().toISOString()}] Sending launch announcement to leads...`);

  if (!process.env.GOOGLE_LEADS_SHEET_ID) {
    console.warn('GOOGLE_LEADS_SHEET_ID not set — nothing to do.');
    return 0;
  }

  const { launchCol } = await ensureTrackingColumns();
  const leads = await getAllLeads();

  let sentCount = 0;

  for (const lead of leads) {
    if (!lead.email || lead.launchSent === 'Yes') continue;

    try {
      await sendLaunchAnnouncementEmail({ firstName: lead.firstName, email: lead.email });
      await markLeadField(lead.rowNumber, launchCol, 'Yes');
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to send launch announcement for row ${lead.rowNumber} (${lead.email}):`, err.message);
    }
  }

  console.log(`Launch announcement complete. Sent to ${sentCount} lead(s).`);
  return sentCount;
}

module.exports = { sendLaunchAnnouncementToAllLeads };
