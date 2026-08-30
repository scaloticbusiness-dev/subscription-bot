// jobs/checkLeads.js
// Runs frequently (every 15 minutes). For every lead in the leads sheet:
//   1. Sends an immediate auto-reply if one hasn't been sent yet.
//   2. Sends a nurture follow-up email if it's been 4+ days since they
//      filled out the form and they haven't converted to a paying
//      subscriber yet (checked against the main subscription sheet).
// Both are tracked via columns on the leads sheet so nothing is ever sent
// twice.

const { ensureTrackingColumns, getAllLeads, markLeadField } = require('../lib/leads');
const { findRowByEmail } = require('../lib/sheets');
const { sendLeadAutoReply, sendLeadNurtureEmail } = require('../lib/email');

const NURTURE_AFTER_DAYS = 4;

function daysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

async function checkLeads() {
  console.log(`[${new Date().toISOString()}] Running leads check...`);

  if (!process.env.GOOGLE_LEADS_SHEET_ID) {
    // Leads sheet not configured — nothing to do.
    return;
  }

  const { autoReplyCol, nurtureCol } = await ensureTrackingColumns();
  const leads = await getAllLeads();

  let autoReplyCount = 0;
  let nurtureCount = 0;

  for (const lead of leads) {
    if (!lead.email) continue;

    // --- Auto-reply ---
    if (lead.autoReplySent !== 'Yes') {
      try {
        await sendLeadAutoReply({ firstName: lead.firstName, email: lead.email });
        await markLeadField(lead.rowNumber, autoReplyCol, 'Yes');
        autoReplyCount += 1;
      } catch (err) {
        console.error(`Failed to send auto-reply for row ${lead.rowNumber} (${lead.email}):`, err.message);
      }
    }

    // --- Nurture follow-up ---
    if (!lead.nurtureSent) {
      try {
        const days = daysSince(lead.date);
        if (days !== null && days >= NURTURE_AFTER_DAYS) {
          const converted = await findRowByEmail(lead.email);
          if (converted) {
            await markLeadField(lead.rowNumber, nurtureCol, 'N/A (Converted)');
          } else {
            await sendLeadNurtureEmail({ firstName: lead.firstName, email: lead.email });
            await markLeadField(lead.rowNumber, nurtureCol, 'Yes');
            nurtureCount += 1;
          }
        }
      } catch (err) {
        console.error(`Failed to process nurture for row ${lead.rowNumber} (${lead.email}):`, err.message);
      }
    }
  }

  if (autoReplyCount > 0 || nurtureCount > 0) {
    console.log(`Leads check complete. Sent ${autoReplyCount} auto-repl(y/ies), ${nurtureCount} nurture email(s).`);
  }
}

module.exports = { checkLeads };
