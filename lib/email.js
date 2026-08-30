// lib/email.js
// Sends the "welcome, here's your Discord invite" email after a successful
// Stripe checkout. Uses the Resend API over HTTPS (not SMTP) — Railway's
// Trial/Hobby plans block outbound SMTP, so a regular Gmail/nodemailer setup
// does not work there. Resend's HTTP API has no such restriction.

const RESEND_API_URL = 'https://api.resend.com/emails';

const FROM_ADDRESS = 'Lotik Shorts <team@lotik.gr>';

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

  const apiKey = process.env.RESEND_API_KEY;
  const inviteLink = process.env.DISCORD_INVITE_LINK;

  if (!apiKey || !inviteLink) {
    console.warn(
      'RESEND_API_KEY or DISCORD_INVITE_LINK not set — skipping welcome email.'
    );
    return;
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: toEmail,
      subject: 'Καλώς ήρθες ! Οδηγίες πρόσβασης στο Discord',
      text: buildWelcomeEmailBody(),
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Resend API error: ${res.status} ${errorBody}`);
  }

  console.log(`Sent welcome email to ${toEmail}`);
}

module.exports = { sendWelcomeEmail };
