// routes/testEmail.js
// TEMPORARY test route — lets us confirm the Gmail/nodemailer setup works
// without going through a real Stripe payment. Delete this file (and its
// require/route line in index.js) once the email flow is confirmed working.

const { sendWelcomeEmail } = require('../lib/email');

async function testEmailHandler(req, res) {
  const to = req.query.to;
  if (!to) {
    return res.status(400).json({ ok: false, error: 'Add ?to=your@email.com to the URL' });
  }

  try {
    await sendWelcomeEmail(to);
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (err) {
    console.error('Test email failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = { testEmailHandler };
