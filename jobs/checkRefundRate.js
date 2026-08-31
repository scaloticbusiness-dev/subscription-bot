// jobs/checkRefundRate.js
// Runs once a week (bundled with the other Monday checks). Looks at the
// ratio of refunded to total successful charges over the last 7 days —
// a sudden spike is often the first sign of a quality/expectations
// problem, or a technical issue causing accidental duplicate charges.

const Stripe = require('stripe');
const { listAll } = require('../lib/stripeStats');
const { sendRefundRateAlert } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const LOOKBACK_DAYS = 7;
const REFUND_RATE_THRESHOLD = 0.15; // 15% of charges refunded in the window
const MIN_CHARGES_FOR_SIGNAL = 5; // too few charges below this to mean anything

async function checkRefundRate() {
  console.log(`[${new Date().toISOString()}] Running weekly refund rate check...`);

  const windowStart = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 60 * 60;
  const charges = await listAll((p) => stripe.charges.list(p), { created: { gte: windowStart } });
  const succeeded = charges.filter((c) => c.status === 'succeeded' && c.paid);

  if (succeeded.length < MIN_CHARGES_FOR_SIGNAL) {
    console.log(
      `Refund rate check: only ${succeeded.length} charge(s) in the last ${LOOKBACK_DAYS} days — too few to judge, skipping.`
    );
    return;
  }

  const refundedCount = succeeded.filter((c) => c.amount_refunded > 0).length;
  const refundRate = refundedCount / succeeded.length;

  if (refundRate > REFUND_RATE_THRESHOLD) {
    try {
      await sendRefundRateAlert({
        refundRate,
        refundedCount,
        totalCharges: succeeded.length,
        lookbackDays: LOOKBACK_DAYS,
      });
    } catch (err) {
      console.error('Failed to send refund rate alert:', err.message);
    }
  }

  console.log(
    `Refund rate check complete: ${(refundRate * 100).toFixed(1)}% (${refundedCount}/${succeeded.length}).`
  );
}

module.exports = { checkRefundRate };
