// lib/referralRewards.js
// Applies the refer-a-friend reward: a one-cycle discount on the
// REFERRER's subscription, once the person they referred becomes a paying
// subscriber. Kept separate from routes/stripeWebhook.js so the Stripe
// coupon mechanics don't clutter the webhook handler.
//
// Reward is a single reusable coupon (percent off, applied once), sized by
// REFERRAL_DISCOUNT_PERCENT (defaults to 20%). The coupon is created lazily
// the first time it's needed rather than assumed to already exist.

const Stripe = require('stripe');
const { findRowByDiscordUsername } = require('./sheets');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const REFERRAL_COUPON_ID = 'lotik-referral-reward';

/**
* Returns the referral coupon's id, creating it on Stripe the first time
* it's needed. Safe to call repeatedly — `stripe.coupons.retrieve` will
* find the same coupon on every later call instead of creating duplicates.
*/
async function ensureReferralCoupon() {
try {
const existing = await stripe.coupons.retrieve(REFERRAL_COUPON_ID);
return existing.id;
} catch (err) {
// Falls through to create it below if it doesn't exist yet (any other
                                                             // error re-throws, since silently creating a coupon after an
                                                             // unrelated failure could mask a real problem).
if (err.code !== 'resource_missing') throw err;
}

const percentOff = Number(process.env.REFERRAL_DISCOUNT_PERCENT || 20);
const coupon = await stripe.coupons.create({
  id: REFERRAL_COUPON_ID,
  percent_off: percentOff,
  duration: 'once',
  name: 'Refer-a-friend reward',
  });
console.log(`Created Stripe coupon "${REFERRAL_COUPON_ID}" (${percentOff}% off, once).`);
return coupon.id;
}

/**
* Applies the referral reward to `referrerDiscordUsername`'s active
* subscription, if they have one. Looks the referrer up by Discord
* username -> sheet row -> email -> Stripe customer -> active
* subscription, since the sheet doesn't store Stripe IDs directly.
* Returns true if a discount was actually applied, false otherwise
* (referrer not found, not an active subscriber, or no Stripe
   * subscription found) — never throws, so a lookup miss never blocks the
* referred person's own checkout flow.
*/
async function applyReferralReward(referrerDiscordUsername) {
if (!referrerDiscordUsername) return false;

const referrerRow = await findRowByDiscordUsername(referrerDiscordUsername);
if (!referrerRow || referrerRow.status.toLowerCase() !== 'active' || !referrerRow.email) {
console.log(`Referral reward skipped for "${referrerDiscordUsername}" — not an active subscriber.`);
return false;
}

const customers = await stripe.customers.list({ email: referrerRow.email, limit: 1 });
const customer = customers.data[0];
if (!customer) {
console.log(`Referral reward skipped — no Stripe customer found for ${referrerRow.email}.`);
return false;
}

const subs = await stripe.subscriptions.list({ customer: customer.id, status: 'active', limit: 1 });
const subscription = subs.data[0];
if (!subscription) {
console.log(`Referral reward skipped — no active Stripe subscription found for ${referrerRow.email}.`);
return false;
}

const couponId = await ensureReferralCoupon();
await stripe.subscriptions.update(subscription.id, { discounts: [{ coupon: couponId }] });
console.log(`Applied referral reward (${couponId}) to ${referrerRow.email}'s subscription.`);
return true;
}

module.exports = { applyReferralReward };
