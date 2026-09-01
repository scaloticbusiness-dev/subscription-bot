// jobs/checkDisputeDeadlines.js
// Runs once a day (bundled with the other daily checks). Stripe disputes
// have a hard evidence-submission deadline — miss it and the dispute is
// lost automatically, no matter how strong the case would have been. The
// existing chargeback alert (routes/stripeWebhook.js) fires once, the
// moment a dispute is created; this is the safety net for when that
// single alert gets missed or buried as the deadline creeps closer.
//
// Deliberately stateless: it just re-lists disputes still needing a
// response every time it runs, and only alerts if the deadline is close
// (REMINDER_WINDOW_DAYS). Once evidence is submitted (or Stripe
// auto-resolves the dispute another way), it drops out of
// "needs_response" and the reminders stop on their own — no separate
// tracking/debounce needed, same "safe to over-alert, never safe to
// silently miss" philosophy as the rest of the daily/weekly checks here.

const Stripe = require('stripe');
const { listAll } = require('../lib/stripeStats');
const { sendDisputeDeadlineReminder } = require('../lib/email');
const { sendChannelMessage } = require('../lib/discord');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
// Dispute statuses where Stripe is still waiting on evidence from us.
// (The other statuses — under_review, won, lost, charge_refunded, etc. —
// are all past the point where a reminder would help.)
const NEEDS_RESPONSE_STATUSES = new Set(['needs_response', 'warning_needs_response']);

// Start nudging once the deadline is this many days away or closer.
const REMINDER_WINDOW_DAYS = 3;

async function checkDisputeDeadlines() {
  console.log(`[${new Date().toISOString()}] Running dispute deadline check...`);

  const disputes = await listAll((p) => stripe.disputes.list(p));
  const now = Math.floor(Date.now() / 1000);

  const urgent = disputes
    .filter((d) => NEEDS_RESPONSE_STATUSES.has(d.status) && d.evidence_details?.due_by)
    .map((d) => ({
      id: d.id,
      amount: (d.amount / 100).toFixed(2),
      currency: d.currency.toUpperCase(),
      reason: d.reason,
      dueBy: d.evidence_details.due_by,
      daysLeft: Math.ceil((d.evidence_details.due_by - now) / (24 * 60 * 60)),
}))
    .filter((d) => d.daysLeft <= REMINDER_WINDOW_DAYS);

  if (urgent.length === 0) {
    console.log('Dispute deadline check: nothing within the reminder window.');
    return;
}

for (const d of urgent) {
const dueByLabel = new Date(d.dueBy * 1000).toISOString().slice(0, 10);
const urgencyLabel = d.daysLeft <= 1 ? '🔴 ΣΗΜΕΡΑ/ΑΥΡΙΟ' : `⚠️ ${d.daysLeft} μέρες`;

try {
await sendDisputeDeadlineReminder({
disputeId: d.id,
amount: d.amount,
currency: d.currency,
reason: d.reason,
dueByLabel,
daysLeft: d.daysLeft,
});
} catch (err) {
console.error(`Failed to send dispute deadline email for ${d.id}:`, err.message);
}

try {
await sendChannelMessage(
process.env.ADMIN_ALERT_CHANNEL_ID,
`${urgencyLabel} **Ανοιχτό dispute χωρίς evidence** (${d.id})
${d.amount} ${d.currency} — προθεσμία υποβολής: ${dueByLabel}
Υπόβαλε evidence στο Stripe Dashboard → Payments → Disputes πριν χαθεί αυτόματα (χάνεται εξ ορισμού αν περάσει η προθεσμία).`
);
} catch (err) {
console.error(`Failed to send admin Discord alert for dispute ${d.id}:`, err.message);
}
}

console.log(`Dispute deadline check complete: ${urgent.length} dispute(s) reminded.`);
}

module.exports = { checkDisputeDeadlines };
