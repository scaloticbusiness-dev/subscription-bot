// routes/unsubscribe.js
// GET /unsubscribe?email=someone@example.com
//
// One-click unsubscribe link included in every promotional/marketing email
// (win-back, launch announcement, nurture, check-in). No login/token
// required — this only stops future marketing sends to the address, which
// is a low-stakes action, and requiring a token would mean generating and
// tracking one per email sent for little real benefit.
//
// Marks the email as unsubscribed in BOTH the main subscription sheet and
// the leads sheet, since the same person could be in either or both.
// Transactional emails (welcome, payment failed, receipts) are NOT
// affected — those keep sending regardless, since they're operational,
// not marketing.

const { findRowByEmail, updateRow } = require('../lib/sheets');
const { markLeadsUnsubscribed } = require('../lib/leads');

function renderConfirmationPage(email) {
  return `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="utf-8">
<title>Απεγγραφή</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; text-align: center; color: #222; }
  h1 { font-size: 1.4rem; }
  p { color: #555; line-height: 1.5; }
</style>
</head>
<body>
  <h1>✅ Έγινε</h1>
  <p>Το <strong>${email}</strong> δεν θα λαμβάνει πλέον προωθητικά/ενημερωτικά emails από το Lotik Shorts.</p>
  <p>Emails που αφορούν ενεργή συνδρομή σου (π.χ. αποτυχημένη χρέωση) θα συνεχίσουν να στέλνονται κανονικά, καθώς είναι λειτουργικά και όχι προωθητικά.</p>
</body>
</html>`;
}

async function unsubscribeHandler(req, res) {
  const email = req.query.email;
  if (!email) {
    return res.status(400).send('Missing ?email=');
  }

  try {
    const mainRow = await findRowByEmail(email);
    if (mainRow) {
      await updateRow(mainRow.rowNumber, { unsubscribed: 'Yes' });
    }

    const leadsUpdated = await markLeadsUnsubscribed(email);

    console.log(`Unsubscribed ${email} (main sheet: ${mainRow ? 'yes' : 'no'}, leads rows: ${leadsUpdated}).`);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderConfirmationPage(email));
  } catch (err) {
    console.error(`Failed to process unsubscribe for ${email}:`, err.message);
    res.status(500).send('Κάτι πήγε στραβά. Δοκίμασε ξανά αργότερα ή απάντησε σε κάποιο email μας.');
  }
}

module.exports = { unsubscribeHandler };
