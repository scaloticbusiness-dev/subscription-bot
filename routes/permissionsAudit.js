// routes/permissionsAudit.js
// GET /audit-permissions?key=ADMIN_API_KEY
// Runs the channel-permissions audit on demand and returns the full
// issue list + snapshot as JSON, in addition to posting the summary to
// #admin-alerts (same as the scheduled run). Requires ADMIN_API_KEY since
// the response includes the server's full permission layout.

const { checkChannelPermissions, formatSnapshotLine } = require('../jobs/checkChannelPermissions');
const { requireAdminKey } = require('../lib/adminAuth');

async function permissionsAuditHandler(req, res) {
  if (!requireAdminKey(req, res)) return;

  try {
    const { issues, review, snapshot } = await checkChannelPermissions();
    res.json({
      ok: true,
      issueCount: issues.length,
      issues,
      reviewCount: review.length,
      review,
      snapshot: snapshot.map(formatSnapshotLine),
    });
  } catch (err) {
    console.error('Permissions audit failed:', err.message);
    res.status(500).json({ ok: false, error: 'Something went wrong running the permissions audit.' });
  }
}

module.exports = { permissionsAuditHandler };
