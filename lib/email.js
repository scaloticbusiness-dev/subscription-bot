// lib/email.js
// Sends the "welcome, here's your Discord invite" email after a successful
// Stripe checkout. Uses Gmail via nodemailer + an App Password (not the
// regular account password — see README/setup notes for how to create one).

const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  return transporter;
}

function buildWelcomeEmailBody() {
  const inviteLink = process.env.DISCORD_INVITE_LINK;

  return `Γεια σου!

Σε ευχαριστώ πολύ που έγινες μέλος του Lotik Shorts — χαίρομαι πολύ που είσαι εδώ και ανυπομονώ να σε δω στην κοινότητα.

Το επόμενο βήμα είναι απλό: μπες στο Discord Server μας από τον παρακάτω σύνδεσμο, και εξερεύνησε τα channels.

👉 ${inviteLink}

Μόλις μπεις, το σύστημά μας θα αναγνωρίσει αυτόματα το username που δήλωσες κατά την εγγραφή σου και θα σου δώσει πρόσβαση στον premium role μέσα σε λίγα λεπτά. Αν για οποιονδήποτε λόγο δεν πάρεις τον ρόλο σου, απλά απάντησε σε αυτό το email και θα το φτιάξω άμεσα.

Χαίρομαι πολύ που είσαι μαζί μας και ανυπομονώ να ξεκινήσουμε!

Με εκτίμηση,
Lotik`;
}

/**
 * Sends the welcome/invite email to a new subscriber.
 * Safe to call even if email vars aren't set — it will just log and skip,
 * so a missing email config never breaks the Stripe webhook flow.
 */
async function sendWelcomeEmail(toEmail) {
  if (!toEmail) {
    console.warn('sendWelcomeEmail called with no recipient email — skipping.');
    return;
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  const inviteLink = process.env.DISCORD_INVITE_LINK;

  if (!gmailUser || !gmailPass || !inviteLink) {
    console.warn(
      'GMAIL_USER, GMAIL_APP_PASSWORD, or DISCORD_INVITE_LINK not set — skipping welcome email.'
    );
    return;
  }

  const mailer = getTransporter();

  await mailer.sendMail({
    from: `"Lotik Shorts" <${gmailUser}>`,
    to: toEmail,
    subject: 'Καλώς ήρθες ! Οδηγίες πρόσβασης στο Discord',
    text: buildWelcomeEmailBody(),
  });

  console.log(`Sent welcome email to ${toEmail}`);
}

module.exports = { sendWelcomeEmail };
