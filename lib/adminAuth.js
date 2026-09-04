// lib/adminAuth.js
// Simple shared-secret check for admin-only routes. Anything that sends
// mail, changes a member's access, or runs an expensive job must sit
// behind this — the service is on a public URL, so an unguarded route is
// open to anyone who finds it. Set ADMIN_API_KEY in the environment and
// pass it as ?key=... on these routes.
//
// The one deliberate exception is /mark-skool-invited, which is a
// one-click link inside our own admin email; the worst a stranger can do
// there is flip a bookkeeping flag.

function requireAdminKey(req, res) {
  const configuredKey = process.env.ADMIN_API_KEY;
  if (!configuredKey) {
    res.status(500).json({ ok: false, error: 'ADMIN_API_KEY is not configured on the server.' });
    return false;
  }
  if (req.query.key !== configuredKey) {
    res.status(401).json({ ok: false, error: 'Missing or invalid key.' });
    return false;
  }
  return true;
}

module.exports = { requireAdminKey };
