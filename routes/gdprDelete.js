// routes/gdprDelete.js
// GET /gdpr-delete?email=...&key=ADMIN_API_KEY                  → preview (dry run)
// GET /gdpr-delete?email=...&key=ADMIN_API_KEY&confirm=DELETE   → actually erase
//
// The companion to routes/gdprExport.js: that one hands over everything we
// hold about an email so a "please export/delete my data" request can be
// answered; this one performs the deletion half, which gdprExport
// deliberately left out ("deletion isn't implemented here — it needs a
// human to confirm before removing anything"). This still keeps that
// human-in-the-loop guarantee — nothing is erased unless the request
// explicitly includes &confirm=DELETE — but automates the actual
// multi-system erasure in one step instead of the admin having to
// remember to separately go delete the same person from the main sheet,
// the archive tab, the leads sheet, and Stripe. That's exactly the kind
// of thing that's easy to half-do under a GDPR erasure deadline, leaving
// a partial trail behind.
//
// Scope: the main subscription sheet row, the Archive tab row, matching
// Leads sheet rows (redacted in place rather than row-deleted — see
                     // lib/leads.js), and the Stripe Customer object. Deliberately does NOT
// touch Discord — removing server access/roles is a moderation decision,
// not data erasure, and Discord's own message history isn't ours to
// delete anyway.
//
// Requires ADMIN_API_KEY since this both reads and destroys personal data.

const Stripe = require('stripe');
const { findRowByEmail, findArchivedRowByEmail, deleteRow, deleteArchiveRow } = require('../lib/sheets');
const { findLeadsByEmail, redactLeadsByEmail } = require('../lib/leads');
const { requireAdminKey } = require('../lib/adminAuth');
const { sendChannelMessage } = require('../lib/discord');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function findStripeCustomers(email) {
  const customers = await stripe.customers.list({ email, limit: 10 });
  return customers.data;
  }

async function gdprDeleteHandler(req, res) {
  if (!requireAdminKey(req, res)) return;

  const email = (req.query.email || '').trim();
  if (!email) {
    res.status(400).json({ ok: false, error: 'Missing ?email=' });
    return;
    }

  const confirmed = req.query.confirm === 'DELETE';

  try {
    const [mainRow, archivedRow, leads, stripeCustomers] = await Promise.all([
      findRowByEmail(email),
      findArchivedRowByEmail(email),
      findLeadsByEmail(email),
      findStripeCustomers(email),
      ]);

    const found = {
      mainSheetRow: mainRow ? { rowNumber: mainRow.rowNumber, status: mainRow.status } : null,
      archiveRow: archivedRow ? { rowNumber: archivedRow.rowNumber } : null,
      leadRows: leads.map((l) => l.rowNumber),
      stripeCustomers: stripeCustomers.map((c) => c.id),
      };

    const nothingFound =
    !found.mainSheetRow && !found.archiveRow && found.leadRows.length === 0 && found.stripeCustomers.length === 0;

    // --- Preview (dry run): report what would be erased, erase nothing. ---
    if (!confirmed) {
      res.json({
        ok: true,
        mode: 'preview',
        email,
        found,
        nothingFound,
        howToConfirm: nothingFound
        ? undefined
        : 'Ξαναφώναξε το ίδιο URL με &confirm=DELETE στο τέλος για να διαγραφούν ΟΡΙΣΤΙΚΑ όλα τα παραπάνω. Δεν αναιρείται.',
        });
      return;
      }

    if (nothingFound) {
      res.json({ ok: true, mode: 'delete', email, deleted: {}, note: 'Δεν βρέθηκε τίποτα για διαγραφή.' });
      return;
      }

    // --- Confirmed: actually erase, one system at a time. ---
    const deleted = {};
    const errors = [];

    // Main sheet row first, specifically — deleting a row shifts every
    // later row's index on that same tab, so doing this before anything
// else that might (in a future change) also touch the main tab keeps
// row numbers looked up above still valid for what follows.
if (found.mainSheetRow) {
try {
await deleteRow(found.mainSheetRow.rowNumber);
deleted.mainSheetRow = true;
} catch (err) {
errors.push(`main sheet row: ${err.message}`);
}
}

if (found.archiveRow) {
try {
await deleteArchiveRow(found.archiveRow.rowNumber);
deleted.archiveRow = true;
} catch (err) {
errors.push(`archive row: ${err.message}`);
}
}

if (found.leadRows.length > 0) {
try {
deleted.leadRowsRedacted = await redactLeadsByEmail(email);
} catch (err) {
errors.push(`leads sheet: ${err.message}`);
}
}

if (found.stripeCustomers.length > 0) {
deleted.stripeCustomers = [];
for (const customerId of found.stripeCustomers) {
try {
await stripe.customers.del(customerId);
deleted.stripeCustomers.push(customerId);
} catch (err) {
// Most common cause: Stripe won't delete a customer that still
    // has an active subscription or open invoice items — cancel/
    // void those in the Stripe Dashboard first, then re-run this
    // same request (with &confirm=DELETE) to finish the rest.
    errors.push(`Stripe customer ${customerId}: ${err.message}`);
    }
  }
}

const summaryLines = [
  `🗑️ **GDPR διαγραφή για ${email}**`,
  found.mainSheetRow ? `Sheet row: ${deleted.mainSheetRow ? '✅ διαγράφηκε' : '❌ απέτυχε'}` : null,
  found.archiveRow ? `Archive row: ${deleted.archiveRow ? '✅ διαγράφηκε' : '❌ απέτυχε'}` : null,
  found.leadRows.length > 0 ? `Leads: ${deleted.leadRowsRedacted || 0}/${found.leadRows.length} redacted` : null,
  found.stripeCustomers.length > 0
  ? `Stripe: ${(deleted.stripeCustomers || []).length}/${found.stripeCustomers.length} διαγράφηκαν`
  : null,
  errors.length > 0 ? `⚠️ Σφάλματα (χρειάζονται χειροκίνητη ολοκλήρωση): ${errors.join(' | ')}` : null,
  ].filter(Boolean);

try {
  await sendChannelMessage(process.env.ADMIN_ALERT_CHANNEL_ID, summaryLines.join('\n'));
  } catch (err) {
  console.error('Failed to send GDPR deletion admin alert:', err.message);
  }

console.log(
  `GDPR deletion for ${email}: ${JSON.stringify(deleted)}${errors.length ? ` — errors: ${errors.join('; ')}` : ''}`
  );

res.json({ ok: errors.length === 0, mode: 'delete', email, deleted, errors: errors.length ? errors : undefined });
} catch (err) {
  console.error('GDPR delete handler failed:', err);
  res.status(500).json({ ok: false, error: err.message });
  }
  }

  module.exports = { gdprDeleteHandler };
