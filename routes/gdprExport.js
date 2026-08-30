// routes/gdprExport.js
// GET /gdpr-export?email=someone@example.com&key=ADMIN_API_KEY
//
// Pulls together every piece of data this system holds about a given
// email address — main subscription sheet, Archive tab, leads sheet, and
// Stripe (customer/subscriptions/charges) — and returns it as a single
// downloadable JSON file. Meant for handling a "please export/delete my
// data" request: run this first to produce the export, then handle
// deletion separately (deletion isn't implemented here — it needs a
// human to confirm before removing anything).
//
// Requires ADMIN_API_KEY since this returns personal data.

const Stripe = require('stripe');
const { findRowByEmail, findArchivedRowByEmail } = require('../lib/sheets');
const { findLeadsByEmail } = require('../lib/leads');
const { getCustomerLifetimeValue } = require('../lib/stripeStats');
const { requireAdminKey } = require('../lib/adminAuth');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function getStripeData(email) {
  const customers = await stripe.customers.list({ email, limit: 10 });
  if (customers.data.length === 0) return null;

  const customerData = [];
  for (const customer of customers.data) {
    const [subscriptions, charges] = await Promise.all([
      stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 }),
      stripe.charges.list({ customer: customer.id, limit: 100 }),
    ]);

    customerData.push({
      customerId: customer.id,
      created: new Date(customer.created * 1000).toISOString(),
      subscriptions: subscriptions.data.map((s) => ({
        id: s.id,
        status: s.status,
        created: new Date(s.created * 1000).toISOString(),
        canceledAt: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
      })),
      charges: charges.data.map((c) => ({
        id: c.id,
        amount: (c.amount / 100).toFixed(2),
        currency: c.currency.toUpperCase(),
        status: c.status,
        refunded: c.amount_refunded > 0,
        created: new Date(c.created * 1000).toISOString(),
      })),
    });
  }

  return customerData;
}

async function gdprExportHandler(req, res) {
  const email = req.query.email;
  if (!email) {
    return res.status(400).json({ ok: false, error: 'Missing ?email=' });
  }
  if (!requireAdminKey(req, res)) return;

  try {
    const [mainRow, archivedRow, leads, stripeData, ltv] = await Promise.all([
      findRowByEmail(email),
      findArchivedRowByEmail(email),
      findLeadsByEmail(email),
      getStripeData(email),
      getCustomerLifetimeValue(email),
    ]);

    const exportData = {
      email,
      exportedAt: new Date().toISOString(),
      subscriptionSheet: mainRow || null,
      archivedSheetRow: archivedRow || null,
      leadFormSubmissions: leads,
      stripe: stripeData,
      lifetimeValue: ltv,
    };

    const found = mainRow || archivedRow || leads.length > 0 || stripeData;
    if (!found) {
      return res.status(404).json({ ok: false, error: `No data found for ${email}.` });
    }

    // Sanitize before using in a header value — email comes straight from
    // the query string, so strip anything that isn't a safe filename
    // character to avoid header injection or a malformed filename.
    const safeFilename = email.replace(/[^a-zA-Z0-9@._-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="gdpr-export-${safeFilename}.json"`);
    res.json(exportData);
  } catch (err) {
    console.error(`GDPR export failed for ${email}:`, err.message);
    res.status(500).json({ ok: false, error: 'Something went wrong building the export.' });
  }
}

module.exports = { gdprExportHandler };
