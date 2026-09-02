// lib/planMigration.js
// Migrates a subscriber from a monthly plan to the yearly plan mid-cycle,
// with Stripe prorating the difference automatically (proration_behavior:
// 'create_prorations' credits the unused portion of the current month and
// charges the yearly difference on the next invoice — no separate manual
// invoice needed).
//
// Requires STRIPE_YEARLY_PRICE_ID (the Stripe Price ID of the yearly plan)
// to be set — there's no other way to know which Price to switch someone
// onto, since Stripe doesn't expose "the yearly version of this product" as
// a lookup.

const Stripe = require('stripe');
const { findRowByDiscordUsername, updateRow } = require('./sheets');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Migrates `discordUsername`'s active Stripe subscription to the yearly
 * plan (STRIPE_YEARLY_PRICE_ID), prorating the switch, and updates their
 * sheet row (Plan, Renewal Date, Amount) to match. Never throws for
 * expected "can't do this" cases — instead returns
 * { ok: false, reason: '<Greek message>' } so the calling Discord command
 * can show it directly to the admin. On success, returns
 * { ok: true, row, planLabel, renewalDate, amount }.
 */
async function migrateToYearly(discordUsername) {
  const yearlyPriceId = process.env.STRIPE_YEARLY_PRICE_ID;
  if (!yearlyPriceId) {
    return { ok: false, reason: 'Δεν έχει ρυθμιστεί το STRIPE_YEARLY_PRICE_ID στο Railway.' };
  }

  const row = await findRowByDiscordUsername(discordUsername);
  if (!row) {
    return { ok: false, reason: `Δεν βρέθηκε συνδρομητής με Discord username "${discordUsername}".` };
  }
  if (row.status.toLowerCase() !== 'active') {
    return { ok: false, reason: `Ο/Η ${discordUsername} δεν έχει ενεργή συνδρομή (Status: ${row.status || 'άγνωστο'}).` };
  }
  if (row.plan && row.plan.includes('Yearly')) {
    return { ok: false, reason: `Ο/Η ${discordUsername} είναι ήδη σε ετήσιο πλάνο (${row.plan}).` };
  }
  if (!row.email) {
    return { ok: false, reason: `Δεν υπάρχει email καταχωρημένο για τον/την ${discordUsername}.` };
  }

  const customers = await stripe.customers.list({ email: row.email, limit: 1 });
  const customer = customers.data[0];
  if (!customer) {
    return { ok: false, reason: `Δεν βρέθηκε Stripe customer για το email ${row.email}.` };
  }

  const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
  const subscription = subs.data[0];
  if (!subscription) {
    return { ok: false, reason: `Δεν βρέθηκε ενεργή Stripe συνδρομή για το email ${row.email}.` };
  }

  const currentItem = subscription.items.data[0];
  if (currentItem?.price?.id === yearlyPriceId) {
    return { ok: false, reason: `Η συνδρομή του/της ${discordUsername} είναι ήδη στο ετήσιο Price στο Stripe.` };
  }

  const updated = await stripe.subscriptions.update(subscription.id, {
    items: [{ id: currentItem.id, price: yearlyPriceId }],
    proration_behavior: 'create_prorations',
    expand: ['items.data.price.product'],
  });

  const newItem = updated.items.data[0];
  const productName = newItem?.price?.product?.name || 'Subscription';
  const planLabel = `${productName} - Yearly`;
  const renewalDate = new Date(updated.current_period_end * 1000).toISOString().slice(0, 10);
  const amount = newItem?.price?.unit_amount ? (newItem.price.unit_amount / 100).toFixed(2) : row.amount;

  await updateRow(row.rowNumber, { plan: planLabel, renewalDate, amount });
  console.log(`Migrated ${discordUsername} (${row.email}) to yearly plan (${planLabel}), renews ${renewalDate}.`);

  return { ok: true, row, planLabel, renewalDate, amount };
}

module.exports = { migrateToYearly };
