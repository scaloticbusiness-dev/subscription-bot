// jobs/checkChannelPermissions.js
// On-demand (and optionally weekly) check that compares actual Discord
// channel permissions against the rules in lib/permissionsAudit.js. Posts
// a report to the admin-alerts channel — runs whether or not it finds
// anything, so silence never means "we forgot to run it".

const { runPermissionsAudit } = require('../lib/permissionsAudit');
const { sendChannelMessage } = require('../lib/discord');

function formatSnapshotLine(channel) {
  const everyoneBits = [
    channel.everyone.view ? 'View' : null,
    channel.everyone.send ? 'Send' : null,
  ]
    .filter(Boolean)
    .join('+') || 'κανένα';
  const roleBits = channel.roles
    .map((r) => `${r.roleName}: ${[r.view ? 'View' : null, r.send ? 'Send' : null].filter(Boolean).join('+') || 'κανένα'}`)
    .join(', ');
  return `#${channel.name} — @everyone: ${everyoneBits}${roleBits ? ` | ${roleBits}` : ''}`;
}

async function checkChannelPermissions() {
  console.log(`[${new Date().toISOString()}] Running channel permissions audit...`);
  const { issues, snapshot } = await runPermissionsAudit();

  let report;
  if (issues.length === 0) {
    report = `✅ **Permissions audit** — όλα τα channels με ορισμένους κανόνες είναι σωστά ρυθμισμένα (${snapshot.length} text channels ελέγχθηκαν συνολικά).`;
  } else {
    report = `⚠️ **Permissions audit** βρήκε ${issues.length} θέμα(τα):\n\n${issues.join('\n')}`;
  }

  await sendChannelMessage(process.env.ADMIN_ALERT_CHANNEL_ID, report);
  console.log(`Permissions audit complete. ${issues.length} issue(s).`);
  return { issues, snapshot };
}

module.exports = { checkChannelPermissions, formatSnapshotLine };
