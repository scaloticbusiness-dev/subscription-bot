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
  return `#${channel.name} [${channel.category}] — @everyone: ${everyoneBits}${roleBits ? ` | ${roleBits}` : ''}`;
}

async function checkChannelPermissions() {
  console.log(`[${new Date().toISOString()}] Running channel permissions audit...`);
  const { issues, review, snapshot } = await runPermissionsAudit();

  const parts = [];
  if (issues.length === 0) {
    parts.push(`✅ **Permissions audit** — όλα τα channels με ορισμένους κανόνες είναι σωστά ρυθμισμένα (${snapshot.length} text channels ελέγχθηκαν συνολικά).`);
  } else {
    parts.push(`⚠️ **Permissions audit** βρήκε ${issues.length} θέμα(τα):\n\n${issues.join('\n')}`);
  }
  if (review.length > 0) {
    parts.push(`\n📋 **${review.length} σημείο(α) για χειροκίνητο έλεγχο** (όχι σίγουρα λάθος, απλά ασυνήθιστα):\n\n${review.join('\n')}`);
  }
  const report = parts.join('\n');

  await sendChannelMessage(process.env.ADMIN_ALERT_CHANNEL_ID, report);
  console.log(`Permissions audit complete. ${issues.length} issue(s), ${review.length} review flag(s).`);
  return { issues, review, snapshot };
}

module.exports = { checkChannelPermissions, formatSnapshotLine };
