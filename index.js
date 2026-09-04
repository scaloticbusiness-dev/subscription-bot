// index.js
// Entry point. Starts the web server (for the Stripe webhook) and schedules
// the daily jobs (expiration check, milestone check, win-back check) and
// the weekly jobs (business summary report, consistency audit).
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { stripeWebhookHandler } = require('./routes/stripeWebhook');
const { checkExpiredSubscriptions } = require('./jobs/checkExpiredSubscriptions');
const { checkMilestones } = require('./jobs/checkMilestones');
const { checkWinBack } = require('./jobs/checkWinBack');
const { checkRenewalReminders } = require('./jobs/checkRenewalReminders');
const { checkCheckIn } = require('./jobs/checkCheckIn');
const { checkReengagement } = require('./jobs/checkReengagement');
const { checkUpsellOffer } = require('./jobs/checkUpsellOffer');
const { runArchiveCheck } = require('./jobs/checkArchive');
const { checkDisputeDeadlines } = require('./jobs/checkDisputeDeadlines');
const { checkToolRenewals } = require('./jobs/checkToolRenewals');
const { checkTicketSLA } = require('./jobs/checkTicketSLA');
const { generateWeeklyReport } = require('./jobs/weeklyReport');
const { runWeeklyAudit } = require('./jobs/weeklyAudit');
const { runWeeklyBackup } = require('./jobs/weeklyBackup');
const { checkWebhookHealth } = require('./jobs/checkWebhookHealth');
const { checkEmailDeliverability } = require('./jobs/checkEmailDeliverability');
const { checkRefundRate } = require('./jobs/checkRefundRate');
const { checkLeads } = require('./jobs/checkLeads');
const { generateWeeklyLeadsReport } = require('./jobs/weeklyLeadsReport');
const { sendLaunchAnnouncementToAllLeads } = require('./jobs/sendLaunchAnnouncement');
const { generateMonthlyReport } = require('./jobs/monthlyReport');
const { runCohortAnalysis } = require('./jobs/cohortAnalysis');
const { generateAccountantSummary } = require('./jobs/monthlyAccountantSummary');
const { checkEventReminders } = require('./jobs/checkEventReminders');
const { checkSopReminders } = require('./jobs/checkSopReminders');
const { generateWinsDigest } = require('./jobs/monthlyWinsDigest');
const { ensureHeaderRow } = require('./lib/sheets');
const { ensureFaqSheet } = require('./lib/faq');
const { ensureExitFeedbackSheet } = require('./lib/exitFeedback');
const { ensureToolRenewalsSheet } = require('./lib/toolRenewals');
const { startDiscordGateway } = require('./lib/discordGateway');
const { requireAdminKey } = require('./lib/adminAuth');
const { markSkoolInvitedHandler } = require('./routes/markSkoolInvited');
const { gdprExportHandler } = require('./routes/gdprExport');
const { gdprDeleteHandler } = require('./routes/gdprDelete');
const { manychatWebhookHandler } = require('./routes/manychatWebhook');
const { customerLtvHandler } = require('./routes/customerLtv');
const { unsubscribeHandler } = require('./routes/unsubscribe');
const { broadcastTermsUpdateHandler } = require('./routes/broadcastTermsUpdate');
const { checkUptime } = require('./jobs/checkUptime');
const { permissionsAuditHandler } = require('./routes/permissionsAudit');
const { checkChannelPermissions } = require('./jobs/checkChannelPermissions');
const { checkMentions } = require('./jobs/checkMentions');
const { checkEventWrapup } = require('./jobs/checkEventWrapup');
const { sendIncidentAlert } = require('./lib/email');
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
// Global safety net: if anything crashes the process outside a normal
// try/catch, this is the clearest signal something critical broke. Sends
// an immediate alert with a short runbook, then exits so Railway restarts
// the process cleanly rather than leaving it in a broken state.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    sendIncidentAlert({ errorType: 'Uncaught Exception', message: err.message, stack: err.stack })
      .catch((alertErr) => console.error('Failed to send incident alert:', alertErr.message))
      .finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    console.error('Unhandled promise rejection:', err);
    sendIncidentAlert({ errorType: 'Unhandled Promise Rejection', message: err.message, stack: err.stack })
      .catch((alertErr) => console.error('Failed to send incident alert:', alertErr.message))
      .finally(() => process.exit(1));
});
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
// Serves brand assets (the logo used in the email signature) from
// /assets — a stable HTTPS URL under our own domain rather than
// hotlinking to an external host.
app.use('/assets', express.static(path.join(__dirname, 'public')));
    app.get('/', (req, res) => {
          res.send('Subscription bot is running.');
    });
    app.get('/health', (req, res) => {
          res.json({ status: 'ok', time: new Date().toISOString() });
    });
    // Optional: trigger the expiration check manually for testing.
  // Visit this URL once after deploying to confirm everything is wired up.
  app.get('/run-expiration-check', async (req, res) => {
        if (!requireAdminKey(req, res)) return;
        try {
                await checkExpiredSubscriptions();
                res.json({ ok: true });
        } catch (err) {
                console.error(err);
                res.status(500).json({ ok: false, error: err.message });
        }
  });

  // TEMPORARY: trigger the archive check manually for testing, optionally
  // overriding the 90-day threshold via ?days=0 to force-archive Expired
  // rows regardless of age. Remove this route once confirmed working.
  app.get('/run-archive-check', async (req, res) => {
        if (!requireAdminKey(req, res)) return;
        try {
                const days = req.query.days !== undefined ? Number(req.query.days) : undefined;
                await runArchiveCheck(days);
                res.json({ ok: true });
        } catch (err) {
                console.error(err);
                res.status(500).json({ ok: false, error: err.message });
        }
  });

  // One-click confirmation link sent inside the Skool invite reminder email.
  app.get('/mark-skool-invited', markSkoolInvitedHandler);

  // One-click unsubscribe link included in marketing/promotional emails
  // (win-back, launch announcement, nurture, check-in). No key required —
  // low-stakes action, just an opt-out.
  app.get('/unsubscribe', unsubscribeHandler);

  // GDPR data export: everything held about one email, as a downloadable
  // JSON file. Requires ?key=ADMIN_API_KEY.
  app.get('/gdpr-export', gdprExportHandler);

  // GDPR data DELETION: run /gdpr-export first to answer the request, then
  // this to actually erase it everywhere (sheet, archive, leads, Stripe).
  // Without &confirm=DELETE it only previews what would be removed —
  // nothing is erased until that's explicitly added. Requires
  // ?key=ADMIN_API_KEY.
  app.get('/gdpr-delete', gdprDeleteHandler);

  // Receives captured Instagram DM leads from a ManyChat flow and adds
  // them to the same leads sheet the lotik.gr form writes to. Called by
  // ManyChat's "External Request" action, not by a browser — guarded by
  // its own ?secret=MANYCHAT_WEBHOOK_SECRET rather than ADMIN_API_KEY.
  app.post('/manychat-webhook', manychatWebhookHandler);

  // On-demand lifetime-value lookup for a single customer. Requires
  // ?key=ADMIN_API_KEY.
  app.get('/customer-ltv', customerLtvHandler);

  // Manual trigger for the cohort retention analysis, useful for testing
  // without waiting for the monthly schedule.
  app.get('/run-cohort-analysis', async (req, res) => {
        if (!requireAdminKey(req, res)) return;
        try {
                const table = await runCohortAnalysis();
                res.json({ ok: true, cohorts: table.length });
        } catch (err) {
                console.error(err);
                res.status(500).json({ ok: false, error: err.message });
        }
  });

  // Manual trigger for the monthly report, useful for testing without
  // waiting for the 1st of the month.
  app.get('/run-monthly-report', async (req, res) => {
        if (!requireAdminKey(req, res)) return;
        try {
                await generateMonthlyReport();
                res.json({ ok: true });
        } catch (err) {
                console.error(err);
                res.status(500).json({ ok: false, error: err.message });
        }
  });

  // MANUAL TRIGGER ONLY — call this yourself once the course/Skool
  // community is actually live. Sends the launch announcement to every
  // lead who hasn't received it yet. Safe to call more than once (e.g. if
  // new leads came in after the first send) — it only emails whoever is
  // still unmarked.
  app.get('/send-launch-announcement', async (req, res) => {
        if (!requireAdminKey(req, res)) return;
        try {
                const sent = await sendLaunchAnnouncementToAllLeads();
                res.json({ ok: true, sent });
        } catch (err) {
                console.error(err);
                res.status(500).json({ ok: false, error: err.message });
        }
  });

  // MANUAL TRIGGER ONLY — call this yourself after updating the terms/
  // privacy policy, to notify every Active subscriber. Requires
  // ?key=ADMIN_API_KEY.
  app.get('/broadcast-terms-update', broadcastTermsUpdateHandler);

  // Checks every text channel's Discord permissions against the rules in
  // lib/permissionsAudit.js (private channels actually private, staff
  // channels not visible to members, etc). Posts a summary to
  // #admin-alerts and returns the full report as JSON. Requires
  // ?key=ADMIN_API_KEY since the response includes the server's full
  // permission layout.
  app.get('/audit-permissions', permissionsAuditHandler);

  try {
        await ensureHeaderRow();
  } catch (err) {
        console.error('Could not verify/set the sheet header row on startup:', err.message);
  }
    try {
          await ensureFaqSheet();
    } catch (err) {
          console.error('Could not verify/create the FAQ tab on startup:', err.message);
    }
    try {
          await ensureExitFeedbackSheet();
    } catch (err) {
          console.error('Could not verify/create the Exit Feedback tab on startup:', err.message);
    }
    try {
          await ensureToolRenewalsSheet();
    } catch (err) {
          console.error('Could not verify/create the Tool Renewals tab on startup:', err.message);
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
    // Schedule the daily jobs together: expiration check, milestone check,
  // and win-back check.
  const hour = Number(process.env.DAILY_CHECK_HOUR || 9);
    const cronExpression = `0 ${hour} * * *`; // e.g. "0 9 * * *" = every day at 09:00 UTC
  cron.schedule(cronExpression, () => {
        checkExpiredSubscriptions().catch((err) =>
                console.error('Scheduled expiration check failed:', err)
                                              );
        checkMilestones().catch((err) =>
                console.error('Scheduled milestone check failed:', err)
                                    );
        checkWinBack().catch((err) =>
                console.error('Scheduled win-back check failed:', err)
                                 );
        checkRenewalReminders().catch((err) =>
                console.error('Scheduled renewal reminder check failed:', err)
                                          );
        checkCheckIn().catch((err) =>
                console.error('Scheduled check-in email job failed:', err)
                                 );
        checkReengagement().catch((err) =>
                console.error('Scheduled Discord re-engagement job failed:', err)
                                      );
        checkUpsellOffer().catch((err) =>
                console.error('Scheduled upsell offer job failed:', err)
                                     );
        checkMentions().catch((err) =>
                console.error('Scheduled mentions check failed:', err)
                                  );
        runArchiveCheck().catch((err) =>
                console.error('Scheduled archive check failed:', err)
                                    );
        checkDisputeDeadlines().catch((err) =>
                console.error('Scheduled dispute deadline check failed:', err)
                                          );
        checkToolRenewals().catch((err) =>
                console.error('Scheduled tool renewal check failed:', err)
                                      );
            checkChannelPermissions().catch((err) =>
                    console.error('Scheduled channel permissions audit failed:', err)
            );
  });
    console.log(`Daily expiration check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily milestone check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily win-back check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily renewal reminder check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily check-in email job scheduled for ${hour}:00 UTC.`);
    console.log(`Daily Discord re-engagement job scheduled for ${hour}:00 UTC.`);
    console.log(`Daily upsell offer job scheduled for ${hour}:00 UTC.`);
    console.log(`Daily mentions check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily archive check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily dispute deadline check scheduled for ${hour}:00 UTC.`);
    console.log(`Daily tool renewal check scheduled for ${hour}:00 UTC.`);
      console.log(`Daily channel permissions audit scheduled for ${hour}:00 UTC.`);

  // Schedule the weekly business summary and consistency audit — every
  // Monday at the same hour.
  const weeklyCronExpression = `0 ${hour} * * 1`; // Monday
  cron.schedule(weeklyCronExpression, () => {
        generateWeeklyReport().catch((err) =>
                console.error('Scheduled weekly report failed:', err)
                                         );
        runWeeklyAudit().catch((err) =>
                console.error('Scheduled weekly audit failed:', err)
                                   );
        runWeeklyBackup().catch((err) =>
                console.error('Scheduled weekly backup failed:', err)
                                    );
        checkWebhookHealth().catch((err) =>
                console.error('Scheduled webhook health check failed:', err)
                                       );
        checkEmailDeliverability().catch((err) =>
                console.error('Scheduled email deliverability check failed:', err)
                                             );
        checkRefundRate().catch((err) =>
                console.error('Scheduled refund rate check failed:', err)
                                    );
        checkSopReminders().catch((err) =>
                console.error('Scheduled SOP reminder job failed:', err)
                                      );
  });
    console.log(`Weekly report scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly audit scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly backup scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly webhook health check scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly email deliverability check scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly refund rate check scheduled for Mondays at ${hour}:00 UTC.`);
    console.log(`Weekly SOP reminder scheduled for Mondays at ${hour}:00 UTC.`);

  // Live event reminders (24h/1h/10min before Q&A/webinars) — needs
  // enough precision for the 10-minute mark, so this runs every 5 minutes
  // rather than sharing the 15-minute leads-check cadence.
  cron.schedule('*/5 * * * *', () => {
        checkEventReminders().catch((err) => console.error('Scheduled event reminders check failed:', err));
  });
    console.log('Event reminders check scheduled every 5 minutes.');

  // Uptime monitoring for the main site — checks every 10 minutes and
  // only alerts on a status change (down / recovered), not repeatedly.
  cron.schedule('*/10 * * * *', () => {
        checkUptime().catch((err) => console.error('Scheduled uptime check failed:', err));
  });
    console.log('Site uptime check scheduled every 10 minutes.');

  // Event wrap-up (tagging engaged attendees) — checked every 15 minutes,
  // enough precision since it only needs to catch the ~30-minute window
  // right after an event ends.
  cron.schedule('*/15 * * * *', () => {
        checkEventWrapup().catch((err) => console.error('Scheduled event wrap-up check failed:', err));
  });
    console.log('Event wrap-up check scheduled every 15 minutes.');

  // Leads sheet: check frequently (every 15 minutes) for auto-reply and
  // nurture emails, so leads get a prompt response.
  cron.schedule('*/15 * * * *', () => {
        checkLeads().catch((err) => console.error('Scheduled leads check failed:', err));
  });
    console.log('Leads check scheduled every 15 minutes.');

  // Support ticket SLA monitoring — checks every 30 minutes so a breach is
  // caught well within the hour, without hammering the Sheets API like a
  // tighter interval would.
  cron.schedule('*/30 * * * *', () => {
        checkTicketSLA().catch((err) => console.error('Scheduled ticket SLA check failed:', err));
  });
    console.log('Ticket SLA check scheduled every 30 minutes.');

  // Weekly leads report — bundled with the other Monday jobs.
  cron.schedule(weeklyCronExpression, () => {
        generateWeeklyLeadsReport().catch((err) =>
                console.error('Scheduled weekly leads report failed:', err)
                                              );
  });
    console.log(`Weekly leads report scheduled for Mondays at ${hour}:00 UTC.`);

  // Monthly business summary (MRR, churn, trends) + cohort retention
  // analysis — run together on the 1st of each month, since both look at
  // the full previous month rather than a rolling 7-day window.
  const monthlyCronExpression = `0 ${hour} 1 * *`; // 1st of the month
  cron.schedule(monthlyCronExpression, () => {
        generateMonthlyReport().catch((err) =>
                console.error('Scheduled monthly report failed:', err)
                                          );
        runCohortAnalysis().catch((err) =>
                console.error('Scheduled cohort analysis failed:', err)
                                      );
        generateAccountantSummary().catch((err) =>
                console.error('Scheduled accountant summary failed:', err)
                                              );
        generateWinsDigest().catch((err) =>
                console.error('Scheduled wins digest failed:', err)
                                       );
  });
    console.log(`Monthly report, cohort analysis, accountant summary, and wins digest scheduled for the 1st of each month at ${hour}:00 UTC.`);
}
main();
