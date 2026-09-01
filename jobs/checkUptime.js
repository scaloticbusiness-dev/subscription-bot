// jobs/checkUptime.js
// Runs frequently (every 10 minutes). Fetches SITE_URL (defaults to
// https://lotik.gr) and alerts the admin only when the status CHANGES —
// down when it was previously up, or recovered when it was previously
// down — rather than repeating the alert every 10 minutes while it stays
// down. State is kept in memory, so a bot restart can cause at most one
// duplicate alert, which is an acceptable tradeoff for simplicity.

const { sendUptimeAlert } = require('../lib/email');

const TIMEOUT_MS = 10000;

let lastKnownUp = true; // assume healthy on cold start; only alerts on an actual observed change

async function checkSiteStatus(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    return { isUp: res.status >= 200 && res.status < 400, statusCode: res.status };
  } catch (err) {
    clearTimeout(timeout);
    return { isUp: false, statusCode: null };
  }
}

async function checkUptime() {
  const url = process.env.SITE_URL || 'https://lotik.gr';
  const { isUp, statusCode } = await checkSiteStatus(url);

  if (!isUp && lastKnownUp) {
    console.warn(`Uptime check: ${url} appears to be DOWN (status: ${statusCode ?? 'no response'}).`);
    try {
      await sendUptimeAlert({ url, status: 'down', statusCode });
    } catch (err) {
      console.error('Failed to send uptime-down alert:', err.message);
    }
  } else if (isUp && !lastKnownUp) {
    console.log(`Uptime check: ${url} has RECOVERED.`);
    try {
      await sendUptimeAlert({ url, status: 'recovered', statusCode });
    } catch (err) {
      console.error('Failed to send uptime-recovered alert:', err.message);
    }
  }

  lastKnownUp = isUp;
}

module.exports = { checkUptime };
