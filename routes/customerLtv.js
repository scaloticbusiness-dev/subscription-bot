// routes/customerLtv.js
// GET /customer-ltv?email=someone@example.com&key=ADMIN_API_KEY
// Returns how much a customer has paid in total, net of refunds, straight
// from Stripe. Requires ADMIN_API_KEY since it's financial data.

const { getCustomerLifetimeValue } = require('../lib/stripeStats');
const { requireAdminKey } = require('../lib/adminAuth');

async function customerLtvHandler(req, res) {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Missing ?email=' });
  }
  if (!requireAdminKey(req, res)) return;

  try {
    const ltv = await getCustomerLifetimeValue(email);
    if (!ltv) {
      return res.status(404).json({ ok: false, error: `No Stripe customer found for ${email}.` });
    }
    res.json({ ok: true, email, ...ltv });
  } catch (err) {
    console.error(`LTV lookup failed for ${email}:`, err.message);
    res.status(500).json({ ok: false, error: 'Something went wrong looking up LTV.' });
  }
}

module.exports = { customerLtvHandler };
