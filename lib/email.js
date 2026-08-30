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
 *
 * The tone escalates based on how many attempts Stripe has already made:
 *   - 1st failure: gentle heads-up
 *   - 2nd+ failure (more retries scheduled): more urgent
 *   - final failure (no more retries scheduled): last-chance warning
 */
async function sendPaymentFailedEmail({ name, email, attemptCount = 1, isFinalAttempt = false }) {
  if (!email) return;

  const firstName = name ? ' ' + name.split(' ')[0] : '';
  let intro;
  let urgency;

  if (isFinalAttempt) {
    intro = `Αυτή είναι η τελευταία προσπάθεια χρέωσης για την ανανέωση της συνδρομής σου στο Lotik Shorts, και δυστυχώς απέτυχε ξανά.`;
    urgency = `⚠️ Αν δεν ενημερώσεις τα στοιχεία πληρωμής σου άμεσα, η πρόσβασή σου στο Discord και στο μάθημα θα αφαιρεθεί σύντομα.`;
  } else if (attemptCount >= 2) {
    intro = `Προσπαθήσαμε ξανά να επεξεργαστούμε την ανανέωση της συνδρομής σου στο Lotik Shorts, αλλά η χρέωση απέτυχε για δεύτερη φορά.`;
    urgency = `Σε παρακαλώ ενημέρωσε τα στοιχεία πληρωμής σου το συντομότερο δυνατό, πριν εξαντληθούν οι αυτόματες προσπάθειες.`;
  } else {
    intro = `Προσπαθήσαμε να επεξεργαστούμε την ανανέωση της συνδρομής σου στο Lotik Shorts, αλλά η χρέωση απέτυχε — συνήθως αυτό οφείλεται σε ληγμένη κάρτα, ανεπαρκές υπόλοιπο, ή κάποιον περιορισμό της τράπεζάς σου.`;
    urgency = `Το Stripe θα ξαναδοκιμάσει τη χρέωση αυτόματα τις επόμενες μέρες, αλλά καλό θα ήταν να ενημερώσεις τα στοιχεία σου νωρίτερα παρά αργότερα.`;
  }

  const text = `Γεια σου${firstName}!

${intro}

${urgency}

Αν χρειάζεσαι βοήθεια, απάντησε σε αυτό το email και θα σε βοηθήσω άμεσα.

Με εκτίμηση,
Lotik`;

  const subject = isFinalAttempt
    ? 'Τελευταία ευκαιρία: η συνδρομή σου κινδυνεύει να ακυρωθεί'
    : attemptCount >= 2
    ? 'Η ανανέωση της συνδρομής σου απέτυχε ξανά'
    : 'Η ανανέωση της συνδρομής σου απέτυχε';

  await sendEmail({ to: email, subject, text });

  console.log(`Sent payment failed email to ${email} (attempt ${attemptCount}, final: ${isFinalAttempt}).`);
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

/**
 * Sends the weekly audit report to the admin, listing any mismatches found
 * between the sheet, Discord roles, and Stripe subscription status. No-op
 * if no issues were found — a quiet system is a healthy system, no need to
 * email "everything is fine" every week.
 */
async function sendAuditReport(issues) {
  if (!issues || issues.length === 0) {
    console.log('Weekly audit: no issues found, skipping email.');
    return;
  }

  const text = `Ο εβδομαδιαίος έλεγχος συνέπειας βρήκε ${issues.length} πιθανό${issues.length === 1 ? '' : 'ά'} πρόβλημα${issues.length === 1 ? '' : 'τα'} μεταξύ sheet, Discord, και Stripe:

${issues.join('\n\n')}

Καλό θα ήταν να τα ελέγξεις χειροκίνητα.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⚠️ Εβδομαδιαίος έλεγχος: ${issues.length} πιθανό${issues.length === 1 ? '' : 'ά'} πρόβλημα${issues.length === 1 ? '' : 'τα'}`,
    text,
  });

  console.log(`Sent weekly audit report with ${issues.length} issue(s).`);
}

/**
 * Alerts the admin when a new checkout looks like a duplicate/suspicious
 * signup — e.g. the same email already has an active subscription, or the
 * same Discord username is already tied to a different active email.
 * `issues` is an array of short description strings.
 */
async function sendDuplicateSignupAlert({ issues, name, email, discordUsername }) {
  if (!issues || issues.length === 0) return;

  const text = `Μια νέα πληρωμή μόλις ήρθε, αλλά κάτι φαίνεται ύποπτο — ίσως διπλή εγγραφή:

Όνομα: ${name || '(no name)'}
Email: ${email}
Discord Username: ${discordUsername || '(κανένα)'}

${issues.join('\n')}

Καλό θα ήταν να το ελέγξεις χειροκίνητα.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⚠️ Πιθανή διπλή εγγραφή: ${name || email}`,
    text,
  });

  console.log(`Sent duplicate signup alert for ${email}.`);
}

/**
 * Sends a "we miss you" win-back email to someone whose subscription ended
 * about 30 days ago, giving them a gentle nudge to come back. Sent only
 * once per person, tracked via the "Win Back Sent" sheet column.
 */
async function sendWinBackEmail({ name, email }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Έχει περάσει περίπου ένας μήνας από τότε που έφυγες από το Lotik Shorts, και σκεφτήκαμε να σου στείλουμε ένα μικρό «γεια» — μας λείπεις στην κοινότητα!

Αν θέλεις να ξαναμπείς, η πόρτα είναι πάντα ανοιχτή. Απλά κάνε μια νέα εγγραφή όποτε είσαι έτοιμος/η, και θα σε καλωσορίσουμε ξανά με χαρά.

Αν έφυγες λόγω κάποιου προβλήματος και θες να μου το πεις, απάντησε ελεύθερα σε αυτό το email.

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Μας λείπεις! 💛',
    text,
  });

  console.log(`Sent win-back email to ${email}.`);
}

/**
 * Alerts the admin if the weekly webhook health check finds Stripe events
 * that haven't been successfully delivered to our endpoint (pending_webhooks
 * > 0), or finds the webhook endpoint itself disabled. This catches silent
 * failures — e.g. the bot crashing repeatedly, or the endpoint accidentally
 * getting disabled — that wouldn't otherwise be noticed until a customer
 * complains.
 */
async function sendWebhookHealthAlert(issues) {
  if (!issues || issues.length === 0) return;

  const text = `Ο εβδομαδιαίος έλεγχος του Stripe webhook βρήκε πιθανό πρόβλημα:

${issues.join('\n')}

Αυτό μπορεί να σημαίνει ότι το bot δεν επεξεργάζεται σωστά κάποιες πληρωμές/ακυρώσεις. Έλεγξε τα Railway logs και το Stripe Dashboard → Developers → Webhooks για λεπτομέρειες.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: '⚠️ Πιθανό πρόβλημα με το Stripe webhook',
    text,
  });

  console.log(`Sent webhook health alert with ${issues.length} issue(s).`);
}

/**
 * Alerts the admin when the same customer has created multiple subscriptions
 * within a short window (signup → cancel → signup again, repeatedly). This
 * can indicate abuse (e.g. repeatedly grabbing temporary access) or a
 * genuinely confused customer — either way, worth a human look.
 */
async function sendRapidCycleAlert({ name, email, subscriptionCount, windowDays }) {
  if (!email) return;

  const text = `Εντοπίστηκε ύποπτος κύκλος εγγραφών/ακυρώσεων:

Όνομα: ${name || '(no name)'}
Email: ${email}
${subscriptionCount} συνδρομές μέσα στις τελευταίες ${windowDays} μέρες.

Αυτό μπορεί να σημαίνει κατάχρηση (π.χ. επανειλημμένη προσωρινή πρόσβαση) ή απλά έναν μπερδεμένο πελάτη. Καλό θα ήταν να το ελέγξεις.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `🔁 Ύποπτος κύκλος εγγραφών: ${name || email}`,
    text,
  });

  console.log(`Sent rapid cycle alert for ${email} (${subscriptionCount} subs in ${windowDays}d).`);
}

/**
 * Sends an immediate auto-reply to someone who just filled out the
 * lotik.gr lead form. The course isn't live yet, so this sets expectations
 * that they'll be notified by email once it launches, rather than
 * promising a specific follow-up timeframe.
 */
async function sendLeadAutoReply({ firstName, email }) {
  if (!email) return;

  const text = `Γεια σου${firstName ? ' ' + firstName : ''}!

Σε ευχαριστώ πολύ που συμπλήρωσες τη φόρμα ενδιαφέροντος για το YouTube course μου! Έλαβα τα στοιχεία σου.

Το course βρίσκεται στα τελευταία στάδια προετοιμασίας και αναμένεται να είναι διαθέσιμο τις επόμενες ημέρες. Θα ενημερωθείς εδώ, σε αυτό το email, μόλις ανοίξουν οι εγγραφές.

Στο μεταξύ, αν έχεις οποιαδήποτε ερώτηση, μη διστάσεις να απαντήσεις σε αυτό το email.

Τα λέμε σύντομα!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Έλαβα το ενδιαφέρον σου! 🎬',
    text,
  });

  console.log(`Sent lead auto-reply to ${email}.`);
}

/**
 * Sends a follow-up "nurture" email to a lead who hasn't converted to a
 * paying subscriber a few days after filling out the form. Reflects that
 * the course is still being finalized rather than promising it's already
 * available.
 */
async function sendLeadNurtureEmail({ firstName, email }) {
  if (!email) return;

  const text = `Γεια σου${firstName ? ' ' + firstName : ''}!

Ήθελα απλά να επανέλθω σχετικά με το ενδιαφέρον σου για το YouTube course μου. Ακόμα ετοιμάζουμε τις τελευταίες λεπτομέρειες, αλλά είσαι ήδη στη λίστα και θα σε ενημερώσω εδώ, σε αυτό το email, μόλις ανοίξουν οι εγγραφές.

Αν έχεις οποιαδήποτε ερώτηση στο μεταξύ, απάντησε ελεύθερα σε αυτό το email — χαίρομαι πάντα να βοηθάω.

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Ακόμα ετοιμάζουμε το course — να σε κρατήσω ενήμερο/η',
    text,
  });

  console.log(`Sent lead nurture email to ${email}.`);
}

/**
 * Sends the weekly leads summary email (new leads, breakdown by source,
 * conversion rate to paying subscribers) to the admin.
 */
async function sendWeeklyLeadsReport({ totalLeads, sourceBreakdown, convertedCount }) {
  const sourceLines = Object.entries(sourceBreakdown)
    .map(([source, count]) => `  - ${source}: ${count}`)
    .join('\n');

  const conversionRate = totalLeads > 0 ? ((convertedCount / totalLeads) * 100).toFixed(1) : '0.0';

  const text = `Εβδομαδιαία σύνοψη leads (τελευταίες 7 μέρες):

📋 Νέα leads: ${totalLeads}
${sourceLines || '  (καμία πηγή)'}

✅ Έγιναν συνδρομητές: ${convertedCount} (${conversionRate}%)

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `Εβδομαδιαία σύνοψη leads: ${totalLeads} νέα, ${convertedCount} conversions`,
    text,
  });

  console.log('Sent weekly leads report email.');
}

/**
 * Alerts the admin when two different leads share the same phone number
 * with different emails — could be a duplicate submission, a typo, or
 * someone testing multiple entries.
 */
async function sendDuplicatePhoneAlert({ phone, name, email, existingEmail }) {
  const text = `Δύο leads μοιράζονται το ίδιο τηλέφωνο με διαφορετικά emails:

Τηλέφωνο: ${phone}
Νέο lead: ${name || '(no name)'} — ${email}
Υπάρχον lead με ίδιο τηλέφωνο: ${existingEmail}

Καλό θα ήταν να το ελέγξεις — μπορεί να είναι το ίδιο άτομο.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `📞 Διπλότυπο τηλέφωνο: ${phone}`,
    text,
  });

  console.log(`Sent duplicate phone alert for ${phone}.`);
}

/**
 * Sends the "course is live!" launch announcement to a lead. Only ever
 * triggered manually (via the /send-launch-announcement route) once the
 * course/Skool community is actually ready — never scheduled automatically.
 */
async function sendLaunchAnnouncementEmail({ firstName, email }) {
  if (!email) return;

  const signupLink = process.env.COURSE_SIGNUP_LINK || 'lotik.gr';

  const text = `Γεια σου${firstName ? ' ' + firstName : ''}!

Έχουν καλά νέα: το YouTube course είναι πλέον ΖΩΝΤΑΝΟ! 🚀

Μιας και είχες δείξει ενδιαφέρον νωρίτερα, ήθελα να είσαι από τους πρώτους που θα το μάθουν.

👉 ${signupLink}

Αν έχεις οποιαδήποτε ερώτηση πριν εγγραφείς, απάντησε ελεύθερα σε αυτό το email.

Ανυπομονώ να σε δω μέσα!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Το course είναι πλέον διαθέσιμο! 🚀',
    text,
  });

  console.log(`Sent launch announcement to ${email}.`);
}

module.exports = {
  sendWelcomeEmail,
  sendSkoolRemovalAlert,
  sendSkoolInviteReminder,
  sendPaymentFailedEmail,
  sendGoodbyeEmail,
  sendMilestoneEmail,
  sendWeeklyReport,
  sendAuditReport,
  sendDuplicateSignupAlert,
  sendWinBackEmail,
  sendWebhookHealthAlert,
  sendRapidCycleAlert,
  sendLeadAutoReply,
  sendLeadNurtureEmail,
  sendWeeklyLeadsReport,
  sendDuplicatePhoneAlert,
  sendLaunchAnnouncementEmail,
};
