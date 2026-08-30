// jobs/checkLeads.js
// Runs frequently (every 15 minutes). For every lead in the leads sheet:
//   1. Normalizes their phone number to a consistent +30 XXXXXXXXXX format
//      (only for numbers we can confidently recognize as Greek).
//   2. Checks for another lead sharing the same phone with a different
//      email, and alerts the admin if found.
//   3. Sends an immediate auto-reply if one hasn't been sent yet.
//   4. Sends a nurture follow-up email if it's been 4+ days since they
//      filled out the form and they haven't converted to a paying
//      subscriber yet (checked against the main subscription sheet).
// All of these are tracked via columns on the leads sheet so nothing is
// ever sent/done twice.

const { ensureTrackingColumns, getAllLeads, markLeadField, getColumnLetter } = require('../lib/leads');
const { findRowByEmail } = require('../lib/sheets');
const { sendLeadAutoReply, sendLeadNurtureEmail, sendDuplicatePhoneAlert } = require('../lib/email');

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

/**
 * Normalizes a phone number to "+30 XXXXXXXXXX" only when we can
 * confidently recognize it as a Greek mobile/landline number. Numbers with
 * a different country code (e.g. +357, +31) or unrecognized formats are
 * left untouched rather than risk mangling them.
 */
function normalizePhone(raw) {
  if (!raw) return raw;
  const cleaned = raw.replace(/[\s\-()]/g, '');

  if (cleaned.startsWith('+')) {
    const greekMatch = cleaned.match(/^\+30(\d{10})$/);
    if (greekMatch) return `+30 ${greekMatch[1]}`;
    return cleaned; // other country code — leave as-is, just de-spaced
  }

  // Greek mobile: 10 digits starting with 69
  if (/^69\d{8}$/.test(cleaned)) {
    return `+30 ${cleaned}`;
  }
  // Greek landline: 10 digits starting with 2
  if (/^2\d{9}$/.test(cleaned)) {
    return `+30 ${cleaned}`;
  }

  return raw; // unrecognized format — don't guess
}

async function checkLeads() {
  console.log(`[${new Date().toISOString()}] Running leads check...`);

  if (!process.env.GOOGLE_LEADS_SHEET_ID) {
    // Leads sheet not configured — nothing to do.
    return;
  }

  const { autoReplyCol, nurtureCol } = await ensureTrackingColumns();
  const phoneCol = await getColumnLetter('Τηλέφωνο');
  const leads = await getAllLeads();

  let autoReplyCount = 0;
  let nurtureCount = 0;

  for (const lead of leads) {
    if (!lead.email) continue;

    const isNewLead = lead.autoReplySent !== 'Yes';

    // --- Phone normalization + duplicate check (only for newly-seen leads) ---
    if (isNewLead && lead.phone) {
      const normalized = normalizePhone(lead.phone);
      if (normalized !== lead.phone && phoneCol) {
        try {
          await markLeadField(lead.rowNumber, phoneCol, normalized);
        } catch (err) {
          console.error(`Failed to normalize phone for row ${lead.rowNumber}:`, err.message);
        }
      }

      const duplicate = leads.find(
        (other) =>
          other.rowNumber !== lead.rowNumber &&
          other.phone &&
          normalizePhone(other.phone) === normalized &&
          other.email.toLowerCase() !== lead.email.toLowerCase()
      );
      if (duplicate) {
        try {
          await sendDuplicatePhoneAlert({
            phone: normalized,
            name: lead.firstName,
            email: lead.email,
            existingEmail: duplicate.email,
          });
        } catch (err) {
          console.error(`Failed to send duplicate phone alert for row ${lead.rowNumber}:`, err.message);
        }
      }
    }

    // --- Auto-reply ---
    if (isNewLead) {
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
