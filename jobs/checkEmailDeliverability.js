// jobs/checkEmailDeliverability.js
// Runs once a week (bundled with the other Monday health checks). Pulls
// recent emails from the Resend API and computes what % bounced or were
// marked as spam. A rising bounce rate is usually the first sign
// deliverability is degrading — e.g. a domain reputation issue, or a batch
// of bad addresses coming in from leads — and is worth catching before it
// gets bad enough that legitimate emails start landing in spam too.

const RESEND_API_URL = 'https://api.resend.com/emails';
const { sendDeliverabilityAlert } = require('../lib/email');

const LOOKBACK_DAYS = 7;
const BOUNCE_RATE_ALERT_THRESHOLD = 0.05; // 5%
const MIN_SAMPLE_SIZE = 5; // too few emails to draw any conclusion below this
const MAX_PAGES = 25; // safety cap — 20/page, so up to 500 emails scanned

/**
 * Fetches every email sent in the last LOOKBACK_DAYS, paging backwards
 * through Resend's list endpoint (newest first) until we pass the cutoff.
 */
async function fetchRecentEmails() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping deliverability check.');
    return [];
  }

  const cutoff = Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const emails = [];
  let after = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(RESEND_API_URL);
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      throw new Error(`Resend list emails failed: ${res.status} ${await res.text()}`);
    }

    const body = await res.json();
    const pageEmails = body.data || [];
    if (pageEmails.length === 0) break;

    let hitCutoff = false;
    for (const email of pageEmails) {
      const createdAt = new Date(email.created_at).getTime();
      if (createdAt < cutoff) {
        hitCutoff = true;
        break;
      }
      emails.push(email);
    }

    if (hitCutoff || !body.has_more) break;
    after = pageEmails[pageEmails.length - 1].id;
  }

  return emails;
}

async function checkEmailDeliverability() {
  console.log(`[${new Date().toISOString()}] Running weekly email deliverability check...`);

  let emails;
  try {
    emails = await fetchRecentEmails();
  } catch (err) {
    console.error('Failed to fetch recent emails from Resend:', err.message);
    return;
  }

  if (emails.length < MIN_SAMPLE_SIZE) {
    console.log(
      `Deliverability check: only ${emails.length} email(s) in the last ${LOOKBACK_DAYS} days — too few to judge, skipping.`
    );
    return;
  }

  const bounced = emails.filter((e) => e.last_event === 'bounced').length;
  const complained = emails.filter((e) => e.last_event === 'complained').length;
  const bounceRate = bounced / emails.length;
  const complaintRate = complained / emails.length;

  const issues = [];
  if (bounceRate > BOUNCE_RATE_ALERT_THRESHOLD) {
    issues.push(
      `❗ Bounce rate ${(bounceRate * 100).toFixed(1)}% τις τελευταίες ${LOOKBACK_DAYS} μέρες (${bounced}/${emails.length}) — πάνω από το όριο των ${(BOUNCE_RATE_ALERT_THRESHOLD * 100).toFixed(0)}%.`
    );
  }
  if (complained > 0) {
    issues.push(
      `❗ ${complained} παράπονο${complained === 1 ? '' : 'α'} spam τις τελευταίες ${LOOKBACK_DAYS} μέρες.`
    );
  }

  try {
    await sendDeliverabilityAlert({ issues, totalEmails: emails.length, bounceRate, complaintRate });
  } catch (err) {
    console.error('Failed to send deliverability alert:', err.message);
  }

  console.log(
    `Deliverability check complete. ${emails.length} email(s) checked, ${bounced} bounced, ${complained} complained.`
  );
}

module.exports = { checkEmailDeliverability };
