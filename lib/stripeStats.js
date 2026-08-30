// lib/stripeStats.js
// Shared helpers for Stripe-derived reporting (monthly report, cohort
// analysis, LTV lookups). Stripe is treated as the source of truth for all
// of this — same approach as jobs/weeklyReport.js — rather than keeping a
// separate local database.
//
// jobs/weeklyReport.js fetches with a flat `limit: 100` and a comment that
// this is "fine at this scale". These stats need to be correct at any
// scale (a wrong MRR/churn number is worse than a wrong weekly headline),
// so everything here paginates through the full result set instead.

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Generic paginator for any Stripe `list` method that supports
 * `starting_after`. Returns the full array across all pages.
 */
async function listAll(stripeListFn, params = {}) {
  const results = [];
  let startingAfter;

  for (;;) {
    const page = await stripeListFn({
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    results.push(...page.data);
    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return results;
}

/**
 * Converts a subscription's price into a monthly-normalized amount (in the
 * price's currency's smallest unit, e.g. cents). Only handles the interval
 * types actually in use by this business (month/year); anything else is
 * treated as already-monthly to fail safe rather than throw.
 */
function monthlyAmountForItem(item) {
  const price = item.price;
  if (!price || !price.unit_amount) return 0;
  const quantity = item.quantity || 1;
  const total = price.unit_amount * quantity;
  const interval = price.recurring?.interval;
  const intervalCount = price.recurring?.interval_count || 1;

  if (interval === 'year') return total / (12 * intervalCount);
  if (interval === 'week') return total * (52 / 12) / intervalCount;
  if (interval === 'day') return total * (365 / 12) / intervalCount;
  return total / intervalCount; // 'month' (or unknown — assume monthly)
}

/**
 * Fetches every currently-active (or trialing) subscription, expanded with
 * price data, and returns them alongside the computed MRR in cents.
 */
async function getActiveSubscriptionsWithMRR() {
  const activeSubs = await listAll(
    (p) => stripe.subscriptions.list(p),
    { status: 'active', expand: ['data.items.data.price'] }
  );
  const trialingSubs = await listAll(
    (p) => stripe.subscriptions.list(p),
    { status: 'trialing', expand: ['data.items.data.price'] }
  );
  const subs = [...activeSubs, ...trialingSubs];

  let mrrCents = 0;
  for (const sub of subs) {
    for (const item of sub.items.data) {
      mrrCents += monthlyAmountForItem(item);
    }
  }

  return { subscriptions: subs, mrrCents: Math.round(mrrCents) };
}

/**
 * Fetches every subscription ever created (any status), for cohort
 * analysis. Only the fields needed for cohorting are kept, to avoid
 * holding a huge expanded object list in memory.
 */
async function getAllSubscriptionsForCohorts() {
  const all = await listAll((p) => stripe.subscriptions.list(p), { status: 'all' });
  return all.map((s) => ({
    id: s.id,
    customer: s.customer,
    created: s.created,
    status: s.status,
    canceledAt: s.canceled_at,
  }));
}

/**
 * Total amount (in the account's default currency's smallest unit) a
 * customer has ever successfully paid, net of refunds. Looks the customer
 * up by email first (Stripe customers, not just subscriptions, so this
 * also covers one-off charges).
 */
async function getCustomerLifetimeValue(email) {
  if (!email) return null;

  const customers = await stripe.customers.list({ email, limit: 10 });
  if (customers.data.length === 0) return null;

  let totalCents = 0;
  let currency = null;
  const customerIds = customers.data.map((c) => c.id);

  for (const customerId of customerIds) {
    const charges = await listAll((p) => stripe.charges.list(p), { customer: customerId });
    for (const charge of charges) {
      if (charge.status !== 'succeeded' || !charge.paid) continue;
      totalCents += charge.amount - (charge.amount_refunded || 0);
      currency = currency || charge.currency;
    }
  }

  return {
    customerIds,
    totalPaid: (totalCents / 100).toFixed(2),
    currency: (currency || 'eur').toUpperCase(),
  };
}

module.exports = {
  listAll,
  monthlyAmountForItem,
  getActiveSubscriptionsWithMRR,
  getAllSubscriptionsForCohorts,
  getCustomerLifetimeValue,
};
