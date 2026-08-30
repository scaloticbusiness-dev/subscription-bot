// index.js
// Entry point. Starts the web server (for the Stripe webhook) and schedules
// the daily jobs that remove the Discord role from expired subscriptions
// and send loyalty milestone emails.
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const { stripeWebhookHandler } = require('./routes/stripeWebhook');
const { checkExpiredSubscriptions } = require('./jobs/checkExpiredSubscriptions');
const { checkMilestones } = require('./jobs/checkMilestones');
const { ensureHeaderRow } = require('./lib/sheets');
const { startDiscordGateway } = require('./lib/discordGateway');
const { testEmailHandler } = require('./routes/testEmail');
const { markSkoolInvitedHandler } = require('./routes/markSkoolInvited');
const REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'DISCORD_BOT_TOKEN',
  'DISCORD_SERVER_ID',
  'DISCORD_ROLE_ID',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'GOOGLE_SHEET_ID',
  'WELCOME_CHANNEL_ID',
];
function checkEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing.join(', '));
    console.error('Copy .env.example to .env and fill in the values (or set them in your hosting dashboard).');
    process.exit(1);
  }
}
async function main() {
  checkEnv();
  const app = express();
  // IMPORTANT: the Stripe webhook route needs the *raw* request body to
  // verify the signature, so it must NOT go through express.json() first.
  app.post(
    '/webhook/stripe',
    express.raw({ type: 'application/json' }),
    stripeWebhookHandler
  );
  // Everything else can use normal JSON parsing.
  app.use(express.json());
  app.get('/', (req, res) => {
    res.send('Subscription bot is running.');
  });
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });
  // Optional: trigger the expiration check manually for testing.
  // Visit this URL once after deploying to confirm everything is wired up.
  app.get('/run-expiration-check', async (req, res) => {
    try {
      await checkExpiredSubscriptions();
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // TEMPORARY: test the welcome email without a real Stripe payment.
  // Visit /test-email?to=your@email.com — remove this route once confirmed working.
  app.get('/test-email', testEmailHandler);

  // One-click confirmation link sent inside the Skool invite reminder email.
  app.get('/mark-skool-invited', markSkoolInvitedHandler);

  try {
    await ensureHeaderRow();
  } catch (err) {
    console.error('Could not verify/set the sheet header row on startup:', err.message);
  }
  try {
    await startDiscordGateway();
  } catch (err) {
    console.error('Could not start Discord gateway connection:', err.message);
  }
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
  // Schedule the daily cancellation check and milestone check together.
  const hour = Number(process.env.DAILY_CHECK_HOUR || 9);
  const cronExpression = `0 ${hour} * * *`; // e.g. "0 9 * * *" = every day at 09:00 UTC
  cron.schedule(cronExpression, () => {
    checkExpiredSubscriptions().catch((err) =>
      console.error('Scheduled expiration check failed:', err)
    );
    checkMilestones().catch((err) =>
      console.error('Scheduled milestone check failed:', err)
    );
  });
  console.log(`Daily expiration check scheduled for ${hour}:00 UTC.`);
  console.log(`Daily milestone check scheduled for ${hour}:00 UTC.`);
}
main();
