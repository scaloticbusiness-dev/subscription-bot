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

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  const confirmLink = baseUrl
    ? `${baseUrl}/mark-skool-invited?email=${encodeURIComponent(email)}`
    : null;

  const text = `Νέα συνδρομή μόλις ολοκληρώθηκε — θυμήσου να στείλεις το Skool invite link σε αυτό το άτομο:

Όνομα: ${name || '(no name)'}
Email: ${email}
Plan: ${plan || ''}
${confirmLink ? `\nΜόλις το στείλεις, πάτα εδώ για να σημειωθεί αυτόματα στο sheet:\n${confirmLink}\n` : ''}
— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `Στείλε Skool invite σε: ${name || email}`,
    text,
  });

  console.log(`Sent Skool invite reminder for ${email}.`);
}

/**
 * Sends a warning email to a subscriber whose renewal payment just failed,
 * so they have a chance to update their card before losing access. Only
 * called for renewal failures (not the very first payment at signup — if
 * that fails, the customer just retries checkout themselves).
 */
async function sendPaymentFailedEmail({ name, email }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Προσπαθήσαμε να επεξεργαστούμε την ανανέωση της συνδρομής σου στο Lotik Shorts, αλλά η χρέωση απέτυχε — συνήθως αυτό οφείλεται σε ληγμένη κάρτα, ανεπαρκές υπόλοιπο, ή κάποιον περιορισμό της τράπεζάς σου.

Για να μη χάσεις την πρόσβασή σου στο Discord και στο μάθημα, ενημέρωσε τα στοιχεία πληρωμής σου το συντομότερο δυνατό. Το Stripe θα ξαναδοκιμάσει τη χρέωση αυτόματα τις επόμενες μέρες, αλλά αν συνεχίσει να αποτυγχάνει, η πρόσβασή σου θα αφαιρεθεί.

Αν χρειάζεσαι βοήθεια, απάντησε σε αυτό το email και θα σε βοηθήσω άμεσα.

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Η ανανέωση της συνδρομής σου απέτυχε',
    text,
  });

  console.log(`Sent payment failed email to ${email}.`);
}

/**
 * Sends a warm goodbye email to the customer themselves right after their
 * subscription ends (cancellation or natural expiry), so the last thing
 * they hear from us is friendly rather than silence.
 */
async function sendGoodbyeEmail({ name, email }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Είδαμε ότι η συνδρομή σου στο Lotik Shorts μόλις έληξε — λυπόμαστε πολύ που φεύγεις! Ήταν χαρά μας που ήσουν μέλος της κοινότητας.

Αν έφυγες λόγω κάποιου προβλήματος ή αν υπάρχει κάτι που θα μπορούσαμε να κάνουμε καλύτερα, θα μου άρεσε πολύ να μου το πεις — απλά απάντησε σε αυτό το email.

Η πόρτα παραμένει πάντα ανοιχτή αν θελήσεις να επιστρέψεις στο μέλλον.

Σε ευχαριστώ ξανά που ήσουν μαζί μας!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Λυπόμαστε που φεύγεις 💛',
    text,
  });

  console.log(`Sent goodbye email to ${email}.`);
}

/**
 * Sends a small celebratory email when a subscriber reaches a loyalty
 * milestone (1 month, 3 months, etc). `milestoneLabel` is a short Greek
 * phrase like "1 μήνα" used directly in the message.
 */
async function sendMilestoneEmail({ name, email, milestoneLabel }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Μόλις συμπλήρωσες ${milestoneLabel} μαζί μας στο Lotik Shorts — σε ευχαριστούμε πολύ που είσαι εδώ! 🎉

Χαιρόμαστε πολύ που σε έχουμε στην κοινότητα και ελπίζουμε να συνεχίσεις να απολαμβάνεις το περιεχόμενο και τις εβδομαδιαίες συναντήσεις μας.

Αν έχεις οποιαδήποτε ιδέα, πρόταση, ή feedback, μη διστάσεις να μου το πεις — απλά απάντησε σε αυτό το email.

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: `Συμπλήρωσες ${milestoneLabel} μαζί μας! 🎉`,
    text,
  });

  console.log(`Sent milestone email (${milestoneLabel}) to ${email}.`);
}

/**
 * Sends the weekly business summary email (new subscriptions, cancellations,
 * revenue) to the admin. Sent every Monday by the weekly report job.
 */
async function sendWeeklyReport({ newSubscriptions, cancellations, revenue, currency }) {
  const text = `Εβδομαδιαία σύνοψη (τελευταίες 7 μέρες):

📈 Νέες συνδρομές: ${newSubscriptions}
📉 Ακυρώσεις: ${cancellations}
💰 Έσοδα: ${revenue} ${currency}

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `Εβδομαδιαία σύνοψη: ${newSubscriptions} νέες, ${cancellations} ακυρώσεις, ${revenue} ${currency}`,
    text,
  });

  console.log('Sent weekly report email.');
}

module.exports = {
  sendWelcomeEmail,
  sendSkoolRemovalAlert,
  sendSkoolInviteReminder,
  sendPaymentFailedEmail,
  sendGoodbyeEmail,
  sendMilestoneEmail,
  sendWeeklyReport,
};
