// routes/broadcastTermsUpdate.js
// GET /broadcast-terms-update?key=ADMIN_API_KEY
//
// MANUAL TRIGGER ONLY — call this yourself after updating TERMS_URL,
// PRIVACY_POLICY_URL, TOS_VERSION, and/or PRIVACY_POLICY_VERSION, to
// notify every Active subscriber that the terms/privacy policy changed.
// Never scheduled automatically, since "terms changed" is a content
// decision only the admin can make.

const { getAllRows } = require('../lib/sheets');
const { sendTermsUpdateEmail } = require('../lib/email');
const { requireAdminKey } = require('../lib/adminAuth');

async function broadcastTermsUpdateHandler(req, res) {
  if (!requireAdminKey(req, res)) return;

  try {
    const rows = await getAllRows();
    const active = rows.filter((r) => r.status.toLowerCase() === 'active' && r.email);

    let sentCount = 0;
    for (const row of active) {
      try {
        await sendTermsUpdateEmail({ name: row.name, email: row.email });
        sentCount += 1;
      } catch (err) {
        console.error(`Failed to send terms update notice to ${row.email}:`, err.message);
      }
    }

    console.log(`Terms update broadcast complete. Sent ${sentCount}/${active.length} email(s).`);
    res.json({ ok: true, sent: sentCount, total: active.length });
  } catch (err) {
    console.error('Terms update broadcast failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { broadcastTermsUpdateHandler };
