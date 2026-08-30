// jobs/checkWebhookHealth.js
// Runs once a week. Asks Stripe directly whether recent events of the types
// we care about have actually been delivered to our webhook endpoint
// (pending_webhooks === 0 means delivered successfully), and whether the
// endpoint itself is still enabled. Catches silent failures — e.g. the bot
// crash-looping, or the endpoint getting accidentally disabled — that would
// otherwise go unnoticed until a customer complains.

const Stripe = require('stripe');
const { sendWebhookHealthAlert } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const WATCHED_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.deleted',
  'invoice.payment_failed',
];

async function checkWebhookHealth() {
  console.log(`[${new Date().toISOString()}] Running weekly webhook health check...`);
  const issues = [];
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  // Check 1: any recent events of our watched types still pending delivery?
  for (const type of WATCHED_EVENT_TYPES) {
    try {
      const events = await stripe.events.list({
        type,
        created: { gte: sevenDaysAgo },
        limit: 20,
      });

      const undelivered = events.data.filter((ev) => ev.pending_webhooks > 0);
      for (const ev of undelivered) {
        const when = new Date(ev.created * 1000).toISOString().slice(0, 16).replace('T', ' ');
        issues.push(`❗ Event ${ev.type} (${ev.id}) από ${when} δεν έχει παραδοθεί ακόμα.`);
      }
    } catch (err) {
      console.error(`Failed to check events of type ${type}:`, err.message);
    }
  }

  // Check 2: is the webhook endpoint itself still enabled?
  try {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/webhook/stripe`
      : null;
    if (baseUrl) {
      const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
      const ours = endpoints.data.find((e) => e.url === baseUrl);
      if (ours && ours.status !== 'enabled') {
        issues.push(`❗ Το webhook endpoint (${baseUrl}) έχει status "${ours.status}" αντί για "enabled".`);
      }
    }
  } catch (err) {
    console.error('Failed to check webhook endpoint status:', err.message);
  }

  try {
    await sendWebhookHealthAlert(issues);
  } catch (err) {
    console.error('Failed to send webhook health alert:', err.message);
  }

  console.log(`Webhook health check complete. Found ${issues.length} issue(s).`);
}

module.exports = { checkWebhookHealth };
