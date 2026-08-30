// lib/email.js
// Sends the "welcome, here's your Discord invite" email after a successful
// Stripe checkout. Uses the Resend API over HTTPS (not SMTP) — Railway's
// Trial/Hobby plans block outbound SMTP, so a regular Gmail/nodemailer setup
// does not work there. Resend's HTTP API has no such restriction.

const RESEND_API_URL = 'https://api.resend.com/emails';

const FROM_ADDRESS = 'Lotik Shorts <team@lotik.gr>';

// Where daily admin alerts (e.g. "remove these people from Skool") get sent.
// Separate from ADMIN's own login — just an inbox you check.
const ADMIN_ALERT_EMAIL = 'scaloticbusiness@gmail.com';

/**
 * Shared low-level sender. Every other function in this file builds a
 * subject/body and calls this. Throws on failure so callers can decide
 * whether to log-and-continue or propagate.
 */
async function sendEmail({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email send.');
    return;
  }

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to, subject, text }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Resend API error: ${res.status} ${errorBody}`);
  }
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

  const inviteLink = process.env.DISCORD_INVITE_LINK;
  if (!inviteLink) {
    console.warn('DISCORD_INVITE_LINK not set — skipping welcome email.');
    return;
  }

  await sendEmail({
    to: toEmail,
    subject: 'Καλώς ήρθες στο Lotik Shorts',
    text: buildWelcomeEmailBody(),
  });

  console.log(`Sent welcome email to ${toEmail}`);
}

/**
 * Sends a daily digest to the admin listing everyone whose subscription
 * just expired (Discord role already removed by this point) so they can be
 * manually removed from Skool — Skool has no public API/webhooks for this,
 * so a same-day manual removal is the best available option.
 * `expiredMembers` is an array of { name, email, plan }.
 * No-op if the list is empty — no need to email "nobody expired today".
 */
async function sendSkoolRemovalAlert(expiredMembers) {
  if (!expiredMembers || expiredMembers.length === 0) return;

  const lines = expiredMembers
    .map((m, i) => `${i + 1}. ${m.name || '(no name)'} — ${m.email} — ${m.plan || ''}`)
    .join('\n');

  const text = `Οι παρακάτω συνδρομές έληξαν σήμερα και ο Discord ρόλος τους αφαιρέθηκε αυτόματα.

Το Skool δεν υποστηρίζει αυτόματη αφαίρεση μελών, οπότε χρειάζεται να τους αφαιρέσεις χειροκίνητα από εκεί:

${lines}

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `Αφαίρεση από Skool: ${expiredMembers.length} μέλ${expiredMembers.length === 1 ? 'ος' : 'η'} έληξαν σήμερα`,
    text,
  });

  console.log(`Sent Skool removal alert for ${expiredMembers.length} member(s).`);
}

/**
 * Alerts the admin immediately after a new subscription is created, so they
 * remember to manually send the Skool invite link to this person's email —
 * Skool is invite-only with no public API, so this step can't be automated
 * and is easy to forget without a reminder.
 */
async function sendSkoolInviteReminder({ name, email, plan }) {
  if (!email) return;

  const text = `Νέα συνδρομή μόλις ολοκληρώθηκε — θυμήσου να στείλεις το Skool invite link σε αυτό το άτομο:

Όνομα: ${name || '(no name)'}
Email: ${email}
Plan: ${plan || ''}

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `Στείλε Skool invite σε: ${name || email}`,
    text,
  });

  console.log(`Sent Skool invite reminder for ${email}.`);
}

module.exports = { sendWelcomeEmail, sendSkoolRemovalAlert, sendSkoolInviteReminder };
