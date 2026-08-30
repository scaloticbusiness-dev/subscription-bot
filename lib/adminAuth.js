// lib/adminAuth.js
// Simple shared-secret check for admin-only routes. Unlike the existing
// routes (test-email, mark-skool-invited), the GDPR export and LTV lookup
// endpoints return personal/financial data, so they need to not be
// publicly guessable. Set ADMIN_API_KEY in the environment and pass it as
// ?key=... on these routes.

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
