// jobs/monthlyReport.js
// Runs on the 1st of each month. Unlike weeklyReport.js (last 7 days,
// headline counts only), this looks at the full previous calendar month
// and adds MRR + churn rate, plus a comparison against the month before
// that so the admin can see the trend, not just a snapshot.

const Stripe = require('stripe');
const { sendMonthlyReport } = require('../lib/email');
const { listAll, getActiveSubscriptionsWithMRR } = require('../lib/stripeStats');

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

/**
 * New subscriptions, cancellations, and net revenue for a given
 * [start, end) window, pulled with full pagination (not just the last 100)
 * so this stays correct as volume grows.
 */
async function statsForRange(start, end) {
  const subsCreated = await listAll(
    (p) => stripe.subscriptions.list(p),
    { created: { gte: start, lt: end }, status: 'all' }
  );

  // Stripe doesn't support filtering list() by canceled_at, so pull all
  // canceled subscriptions and filter client-side (paginated, so this
  // stays correct regardless of total volume).
  const allCanceled = await listAll((p) => stripe.subscriptions.list(p), { status: 'canceled' });
  const cancellations = allCanceled.filter((s) => s.canceled_at && s.canceled_at >= start && s.canceled_at < end);

  const charges = await listAll((p) => stripe.charges.list(p), { created: { gte: start, lt: end } });
  const succeeded = charges.filter((c) => c.status === 'succeeded' && c.paid);
  const revenueCents = succeeded.reduce((sum, c) => sum + (c.amount - (c.amount_refunded || 0)), 0);
  const currency = (succeeded[0]?.currency || 'eur').toUpperCase();

  return {
    newSubscriptions: subsCreated.length,
    cancellations: cancellations.length,
    revenue: (revenueCents / 100).toFixed(2),
    currency,
  };
}

async function generateMonthlyReport() {
  console.log(`[${new Date().toISOString()}] Running monthly report job...`);

  const thisRange = monthRange(1); // most recently completed calendar month
  const prevRange = monthRange(2); // the month before that, for trend comparison

  const [thisMonth, prevMonth] = await Promise.all([
    statsForRange(thisRange.start, thisRange.end),
    statsForRange(prevRange.start, prevRange.end),
  ]);

  // MRR/churn are point-in-time (current active subscriptions), not
  // scoped to the reporting month — that's the correct way to read "MRR"
  // (it's a snapshot, not a monthly total).
  const { subscriptions: currentlyActive, mrrCents } = await getActiveSubscriptionsWithMRR();
  const mrr = (mrrCents / 100).toFixed(2);

  // Churn rate approximation: cancellations this month divided by the
  // active base at the start of the month (current active count plus
  // this month's cancellations, since we don't keep a historical daily
  // snapshot of the active count).
  const activeAtStartEstimate = currentlyActive.length + thisMonth.cancellations;
  const churnRate = activeAtStartEstimate > 0
    ? ((thisMonth.cancellations / activeAtStartEstimate) * 100).toFixed(1)
    : '0.0';

  const revenueDelta = (parseFloat(thisMonth.revenue) - parseFloat(prevMonth.revenue)).toFixed(2);
  const revenueDeltaPct = parseFloat(prevMonth.revenue) > 0
    ? ((revenueDelta / parseFloat(prevMonth.revenue)) * 100).toFixed(1)
    : null;

  await sendMonthlyReport({
    monthLabel: thisRange.label,
    prevMonthLabel: prevRange.label,
    mrr,
    currency: thisMonth.currency,
    churnRate,
    thisMonth,
    prevMonth,
    revenueDelta,
    revenueDeltaPct,
  });

  console.log(
    `Monthly report sent for ${thisRange.label}: MRR ${mrr} ${thisMonth.currency}, churn ${churnRate}%, revenue ${thisMonth.revenue} (prev: ${prevMonth.revenue}).`
  );
}

module.exports = { generateMonthlyReport };
