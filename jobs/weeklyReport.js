// jobs/weeklyReport.js
// Runs every Monday. Pulls the last 7 days of activity directly from Stripe
// (new subscriptions, cancellations, revenue) and emails a short summary to
// the admin. Uses Stripe as the source of truth rather than the sheet, since
// the sheet only tracks current state, not weekly history.

const Stripe = require('stripe');
const { sendWeeklyReport } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function lastSevenDaysRange() {
  const now = new Date();
  const end = Math.floor(now.getTime() / 1000);
  const start = end - 7 * 24 * 60 * 60;
  return { start, end };
}

async function generateWeeklyReport() {
  console.log(`[${new Date().toISOString()}] Running weekly report job...`);
  const { start, end } = lastSevenDaysRange();

  // New subscriptions created this week.
  const subsCreated = await stripe.subscriptions.list({
    created: { gte: start, lte: end },
    limit: 100,
    status: 'all',
  });
  const newSubscriptions = subsCreated.data.length;

  // Cancellations this week. Stripe doesn't support filtering by
  // canceled_at server-side, so fetch recent canceled subscriptions and
  // filter client-side. Fine at this scale (limit 100 covers current volume).
  const canceledSubs = await stripe.subscriptions.list({
    status: 'canceled',
    limit: 100,
  });
  const cancellations = canceledSubs.data.filter(
    (s) => s.canceled_at && s.canceled_at >= start && s.canceled_at <= end
  ).length;

  // Revenue this week: succeeded charges created in range, minus any refunds.
  const charges = await stripe.charges.list({
    created: { gte: start, lte: end },
    limit: 100,
  });
  const succeededCharges = charges.data.filter((c) => c.status === 'succeeded' && c.paid);
  const revenueCents = succeededCharges.reduce(
    (sum, c) => sum + (c.amount - (c.amount_refunded || 0)),
    0
  );
  const revenue = (revenueCents / 100).toFixed(2);
  const currency = (succeededCharges[0]?.currency || 'eur').toUpperCase();

  await sendWeeklyReport({ newSubscriptions, cancellations, revenue, currency });
  console.log(
    `Weekly report sent: ${newSubscriptions} new, ${cancellations} cancelled, ${revenue} ${currency} revenue.`
  );
}

module.exports = { generateWeeklyReport };
