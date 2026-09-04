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
const { sendLeadAutoReply, sendLeadNurtureEmail, sendDuplicatePhoneAlert, sendSpamLeadsAlert, sendNewLeadAlert, describeLeadSource } = require('../lib/email');
const { sendChannelMessage } = require('../lib/discord');
const { evaluateLead } = require('../lib/spam');

const NURTURE_AFTER_DAYS = 4;

// A few leads write several paragraphs into the obstacle field. Discord
// rejects anything over 2000 characters, and a wall of text in a feed is
// unreadable anyway — the point of the card is to let the owner decide in
// two seconds whether this one is worth a personal reply.
const MAX_OBSTACLE_IN_CARD = 300;

function buildLeadCard(lead) {
  const fullName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(χωρίς όνομα)';
  const obstacle = (lead.obstacle || '').trim();
  const short =
    obstacle.length > MAX_OBSTACLE_IN_CARD
      ? `${obstacle.slice(0, MAX_OBSTACLE_IN_CARD).trimEnd()}…`
      : obstacle;

  return [
    `🟢 **Νέο lead** — ${fullName}`,
    `${lead.email || '(χωρίς email)'}${lead.phone ? ` · ${lead.phone}` : ''}`,
    `Κεφάλαιο: ${lead.budget || '—'} · Κανάλι: ${lead.channelStatus || '—'}`,
    `Προέλευση: ${describeLeadSource(lead.page)}`,
    short ? `> ${short.replace(/\n+/g, ' ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

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

  const { autoReplyCol, nurtureCol, spamCol, abVariantCol } = await ensureTrackingColumns();
  const phoneCol = await getColumnLetter('Τηλέφωνο');
  const leads = await getAllLeads();

  let autoReplyCount = 0;
  let nurtureCount = 0;
  const newlyFlaggedSpam = [];

  for (const lead of leads) {
    if (!lead.email) continue;

    // Already flagged as spam in a previous run — skip entirely (no
    // auto-reply, no nurture, no re-checking). Admin can clear the "Spam
    // Flagged" cell manually if it was a false positive.
    if (lead.spamFlagged) continue;

    const isNewLead = lead.autoReplySent !== 'Yes';

    // --- Spam/fake-lead check (only for newly-seen leads, before any
    // email goes out) ---
    if (isNewLead) {
      const verdict = evaluateLead(lead, leads);
      if (verdict.spam) {
        try {
          await markLeadField(lead.rowNumber, spamCol, verdict.reason);
          newlyFlaggedSpam.push({ email: lead.email, phone: lead.phone, reason: verdict.reason });
        } catch (err) {
          console.error(`Failed to flag spam for row ${lead.rowNumber}:`, err.message);
        }
        continue; // skip auto-reply/nurture/duplicate-phone check for this lead
      }
    }

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
        // Random 50/50 split for the subject-line A/B test — assigned once
        // per lead and recorded, so the same lead always sees the same
        // variant even if this job somehow reprocessed them.
        const variant = Math.random() < 0.5 ? 'A' : 'B';
        await sendLeadAutoReply({ firstName: lead.firstName, email: lead.email, variant });
        await markLeadField(lead.rowNumber, autoReplyCol, 'Yes');
        if (abVariantCol) {
          await markLeadField(lead.rowNumber, abVariantCol, variant);
        }
        autoReplyCount += 1;

        // Tell the owner. Each alert is isolated: a broken Discord channel
        // id or a mail hiccup must never stop the lead from being marked
        // as replied-to, or the next run would email them a second time.
        try {
          await sendNewLeadAlert(lead);
        } catch (err) {
          console.error(`Failed to send new-lead email alert for row ${lead.rowNumber}:`, err.message);
        }

        try {
          const channelId = process.env.LEADS_CHANNEL_ID || process.env.ADMIN_ALERT_CHANNEL_ID;
          if (channelId) {
            await sendChannelMessage(channelId, buildLeadCard(lead));
          } else {
            console.warn('Neither LEADS_CHANNEL_ID nor ADMIN_ALERT_CHANNEL_ID is set — skipping Discord lead card.');
          }
        } catch (err) {
          console.error(`Failed to post new-lead Discord card for row ${lead.rowNumber}:`, err.message);
        }
      } catch (err) {
        console.error(`Failed to send auto-reply for row ${lead.rowNumber} (${lead.email}):`, err.message);
      }
    }

    // --- Nurture follow-up ---
    if (!lead.nurtureSent && lead.unsubscribed !== 'Yes') {
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

  if (newlyFlaggedSpam.length > 0) {
    console.log(`Flagged ${newlyFlaggedSpam.length} lead(s) as spam this run.`);
    try {
      await sendSpamLeadsAlert(newlyFlaggedSpam);
    } catch (err) {
      console.error('Failed to send spam leads alert:', err.message);
    }
  }
}

module.exports = { checkLeads };
