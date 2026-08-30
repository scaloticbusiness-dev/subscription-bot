// routes/markSkoolInvited.js
// One-click confirmation link, sent inside the Skool invite reminder email.
// Visiting it marks "Skool Invited" = Yes on the matching sheet row, so the
// admin doesn't have to open the spreadsheet and type it in by hand.
const { findRowByEmail, updateRow } = require('../lib/sheets');

async function markSkoolInvitedHandler(req, res) {
  const email = req.query.email;

  if (!email) {
    return res.status(400).send('Missing email.');
  }

  try {
    const row = await findRowByEmail(email);
    if (!row) {
      return res.status(404).send(`No sheet row found for ${email}.`);
    }

    await updateRow(row.rowNumber, { skoolInvited: 'Yes' });
    console.log(`Marked Skool Invited = Yes for ${email} (via confirmation link)`);

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 60px;">
          <h2>✅ Έγινε!</h2>
          <p>Σημειώθηκε ότι στάλθηκε το Skool invite σε <strong>${email}</strong>.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('Failed to mark Skool Invited via link:', err.message);
    res.status(500).send('Something went wrong updating the sheet.');
  }
}

module.exports = { markSkoolInvitedHandler };
