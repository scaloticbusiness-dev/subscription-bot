// jobs/monthlyAccountantSummary.js
// Runs on the 1st of each month (bundled with the other monthly jobs).
// Pulls the previous calendar month's gross revenue, refunds, and net
// revenue straight from Stripe and emails it to the accountant (or admin,
// if ACCOUNTANT_EMAIL isn't set). This is a data summary, not an official
// tax document — see the disclaimer baked into the email itself.

const Stripe = require('stripe');
const { sendAccountantSummary } = require('../lib/email');
const { listAll } = require('../lib/stripeStats');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Returns the [start, end) unix-second range for the calendar month that is
 * `monthsAgo` months before the current one. monthsAgo=1 means "last
 * month" (the most recently completed calendar month).
 */
function monthRange(monthsAgo) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  return {
    start: Math.floor(start.getTime() / 1000),
    end: Math.floor(end.getTime() / 1000),
    label: start.toLocaleDateString('el-GR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

async function generateAccountantSummary() {
  console.log(`[${new Date().toISOString()}] Running monthly accountant summary job...`);

  const range = monthRange(1);

  const charges = await listAll(
    (p) => stripe.charges.list(p),
    { created: { gte: range.start, lt: range.end } }
  );
  const succeeded = charges.filter((c) => c.status === 'succeeded' && c.paid);

  const grossCents = succeeded.reduce((sum, c) => sum + c.amount, 0);
  const refundedCents = succeeded.reduce((sum, c) => sum + (c.amount_refunded || 0), 0);
  const netCents = grossCents - refundedCents;
  const currency = (succeeded[0]?.currency || 'eur').toUpperCase();

  await sendAccountantSummary({
    monthLabel: range.label,
    gross: (grossCents / 100).toFixed(2),
    refunded: (refundedCents / 100).toFixed(2),
    net: (netCents / 100).toFixed(2),
    currency,
    transactionCount: succeeded.length,
  });

  console.log(`Accountant summary sent for ${range.label}: net ${(netCents / 100).toFixed(2)} ${currency}.`);
}

module.exports = { generateAccountantSummary };
