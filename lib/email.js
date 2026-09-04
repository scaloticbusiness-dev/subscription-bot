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
const BRAND = { red: '#FF2020', darkRed: '#C40D0D', black: '#08080A', white: '#F6F6F8' };

function emailAssetsBaseUrl() { return process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null; }

function emailSignatureHtml() { const site = emailAssetsBaseUrl(); const logoHtml = site ? `<img src="${site}/assets/lotik-logo-horizontal.png" width="110" alt="Lotik" style="display:block;border:0;max-width:110px;">` : `<span style="font-family:Manrope,Arial,sans-serif;font-weight:800;font-size:20px;color:${BRAND.black};">Lotik</span>`; return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr><td style="border-top:1px solid #e6e6e6;padding-top:16px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:16px;vertical-align:middle;">${logoHtml}</td><td style="border-left:1px solid #e6e6e6;padding-left:16px;vertical-align:middle;font-family:Manrope,Arial,sans-serif;font-size:13px;line-height:1.6;color:${BRAND.black};"><div style="font-weight:700;">Lotik Shorts</div><div style="color:#666666;">Faceless YouTube Shorts - Community & Course</div><div style="margin-top:4px;"><a href="https://lotik.gr" style="color:${BRAND.red};text-decoration:none;">lotik.gr</a></div></td></tr></table></td></tr></table>`; }

function textToHtml(text) { const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); const linked = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:' + BRAND.red + ';">$1</a>'); const withBreaks = linked.replace(/\n/g, '<br>'); return '<div style="font-family:Manrope,Arial,sans-serif;font-size:15px;line-height:1.6;color:' + BRAND.black + ';">' + withBreaks + '</div>' + emailSignatureHtml(); }

/**
 * Shared low-level sender. Every other function in this file builds a
 * subject/body and calls this. Throws on failure so callers can decide
 * whether to log-and-continue or propagate.
 *
 * Every email defaults its Reply-To to ADMIN_ALERT_EMAIL (a real, checked
 * inbox) rather than the From address — team@lotik.gr has no mailbox
 * behind it, so without this, any reply a customer/lead sends would go
 * nowhere. Pass `replyTo` to override for a specific email if needed.
 */
async function sendEmail({ to, subject, text, html, replyTo = ADMIN_ALERT_EMAIL }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('RESEND_API_KEY not set — skipping email send.');
    return;
  }
    const finalHtml = html || (text ? textToHtml(text) : undefined);

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
     body: JSON.stringify({ from: FROM_ADDRESS, to, subject, text, html: finalHtml, reply_to: replyTo }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Resend API error: ${res.status} ${errorBody}`);
  }
}

/**
 * Builds the unsubscribe footer appended to every marketing/promotional
 * email (win-back, launch announcement, nurture, check-in) — required for
 * GDPR/e-privacy compliance. Transactional emails (welcome, payment
 * failed, receipts) don't get this, since they're operational rather than
 * marketing and don't need an opt-out.
 */
function unsubscribeFooter(email) {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : null;
  if (!baseUrl || !email) return '';

  const link = `${baseUrl}/unsubscribe?email=${encodeURIComponent(email)}`;
  return `\n\n---\nΑν δεν θέλεις να λαμβάνεις τέτοια emails στο μέλλον, πάτα εδώ: ${link}`;
}

function buildWelcomeEmailBody() {
  const inviteLink = process.env.DISCORD_INVITE_LINK;
  const videoLine = process.env.WELCOME_VIDEO_LINK
    ? `\nΠριν από οτιδήποτε άλλο, δες αυτό το σύντομο βίντεο — εξηγεί πού είναι τα πάντα (μαθήματα στο Skool, κλήσεις στο Discord):\n${process.env.WELCOME_VIDEO_LINK}\n`
    : '';

  return `Γεια σου!

Σε ευχαριστώ πολύ που έγινες μέλος του Lotik Shorts — χαίρομαι πολύ που είσαι εδώ και ανυπομονώ να σε δω στην κοινότητα.
${videoLine}
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

// Sent once, at the 3-month milestone (see checkMilestones.js), asking the
// subscriber how it's going and inviting them to share a testimonial. Kept
// separate from sendMilestoneEmail so the celebratory note and this ask
// stay easy to edit independently.
async function sendTestimonialRequestEmail({ name, email }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Συμπληρώνεις ήδη 3 μήνες μαζί μας στο Lotik Shorts, και ήθελα να σε ρωτήσω κάτι.

Πώς πάει μέχρι στιγμής; Αν έχεις δει κάποια αλλαγή ή αποτέλεσμα χάρη στο πρόγραμμα, θα με χαροποιούσε πολύ να το μοιραστείς μαζί μου — απλά απάντησε σε αυτό το email με λίγα λόγια για την εμπειρία σου.

Αν μου δώσεις την άδεια, θα ήθελα πολύ να το μοιραστώ (ανώνυμα αν προτιμάς) ως testimonial, για να δείξω σε άλλους τι είναι δυνατό.

Ό,τι κι αν γράψεις, σε ευχαριστώ πολύ που είσαι μέρος της κοινότητας!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Πώς πάει μέχρι στιγμής; 🙏',
    text,
  });

  console.log(`Sent testimonial request email to ${email}.`);
}

/**
 * Sends a friendly "how's it going?" check-in email 3-4 days after
 * signup — early enough to catch someone who's confused or stuck before
 * they quietly churn, but not so early it feels like spam right after
 * the welcome email.
 */
async function sendCheckInEmail({ name, email }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Πάνε ήδη μερικές μέρες από τότε που μπήκες στο Lotik Shorts, και ήθελα απλά να περάσω να δω πώς πάει!

Βρήκες εύκολα τον δρόμο σου στο Discord; Έχεις καταφέρει να ξεκινήσεις με το υλικό; Αν κάτι δεν είναι ξεκάθαρο, ή αν κόλλησες κάπου, πες μου ελεύθερα — απλά απάντησε σε αυτό το email.

Χαίρομαι πολύ που είσαι εδώ!

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: 'Πώς πάει; 👋',
    text,
  });

  console.log(`Sent check-in email to ${email}.`);
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
 * Sends the monthly business summary: MRR, churn rate, and a comparison
 * against the previous month so trends (growing/shrinking) are visible at
 * a glance, not just this month's numbers in isolation.
 */
async function sendMonthlyReport({ monthLabel, prevMonthLabel, mrr, currency, churnRate, thisMonth, prevMonth, revenueDelta, revenueDeltaPct }) {
  const trendArrow = parseFloat(revenueDelta) > 0 ? '📈' : parseFloat(revenueDelta) < 0 ? '📉' : '➡️';
  const deltaLine = revenueDeltaPct !== null
    ? `${trendArrow} Έσοδα vs προηγούμενο μήνα: ${revenueDelta >= 0 ? '+' : ''}${revenueDelta} ${currency} (${revenueDeltaPct >= 0 ? '+' : ''}${revenueDeltaPct}%)`
    : `${trendArrow} Έσοδα vs προηγούμενο μήνα: ${revenueDelta >= 0 ? '+' : ''}${revenueDelta} ${currency}`;

  const text = `Μηνιαία αναφορά — ${monthLabel}:

💰 MRR (τρέχον): ${mrr} ${currency}
📊 Churn rate: ${churnRate}%

Αυτόν τον μήνα (${monthLabel}):
  Νέες συνδρομές: ${thisMonth.newSubscriptions}
  Ακυρώσεις: ${thisMonth.cancellations}
  Έσοδα: ${thisMonth.revenue} ${thisMonth.currency}

Προηγούμενος μήνας (${prevMonthLabel}):
  Νέες συνδρομές: ${prevMonth.newSubscriptions}
  Ακυρώσεις: ${prevMonth.cancellations}
  Έσοδα: ${prevMonth.revenue} ${prevMonth.currency}

${deltaLine}

Σημείωση: το churn rate είναι εκτίμηση (ακυρώσεις τον μήνα / [τρέχουσες ενεργές + ακυρώσεις τον μήνα]), αφού δεν κρατάμε ιστορικό daily snapshot του active count.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `📅 Μηνιαία αναφορά ${monthLabel}: MRR ${mrr} ${currency}, churn ${churnRate}%`,
    text,
  });

  console.log('Sent monthly report email.');
}

/**
 * Sends the monthly cohort retention report: for each cohort (grouped by
 * signup month) with enough subscribers to be meaningful, what % were
 * still active at each subsequent month offset. `table` is the array
 * returned by jobs/cohortAnalysis.js's buildCohortTable().
 */
async function sendCohortReport(table) {
  if (!table || table.length === 0) {
    console.log('Cohort analysis: no cohorts with enough signups yet, skipping email.');
    return;
  }

  const lines = table.map(({ cohortKey, size, retention }) => {
    const pctLine = retention.map((r) => `M${r.offset}: ${r.pct}%`).join('  ');
    return `${cohortKey} (${size} συνδρομητές)\n  ${pctLine}`;
  });

  const text = `Μηνιαία ανάλυση cohort retention (μόνο cohorts με 3+ εγγραφές):

${lines.join('\n\n')}

"M0" = ο μήνας εγγραφής, "M1" = έναν μήνα μετά, κ.ο.κ. Το ποσοστό δείχνει πόσοι από την αρχική ομάδα ήταν ακόμα ενεργοί εκείνον τον μήνα.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `📊 Μηνιαία ανάλυση cohort retention (${table.length} cohort${table.length === 1 ? '' : 's'})`,
    text,
  });

  console.log('Sent cohort retention report email.');
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
 *
 * If WINBACK_DISCOUNT_CODE is set (a promotion code created once in the
 * Stripe dashboard — Products → Coupons → Create a promotion code), it's
 * included as a real incentive. Without it, the email still sends, just
 * without a discount line — never blocks on a missing code.
 */
/**
 * Sent a few days before a subscription renews. Not a marketing email — it is
 * the message that stops a renewal from arriving as a surprise, which is where
 * most chargebacks come from. States the amount and the date plainly and makes
 * cancelling easy; someone who was going to leave anyway costs far less as a
 * cancellation than as a dispute.
 */
async function sendRenewalReminderEmail({ name, email, amount, renewalDate, plan }) {
  if (!email) return;

  const isYearly = (plan || '').toLowerCase().includes('year');
  const period = isYearly ? 'ετήσια' : 'μηνιαία';
  const price = amount ? `€${amount}` : (isYearly ? '€249' : '€39');

  const text = `Γεια σου${name ? ' ' + name : ''}!

Μια ειδοποίηση για να μη σε πιάσει απροετοίμαστο: η ${period} συνδρομή σου στο Lotik Shorts ανανεώνεται στις ${renewalDate} και θα χρεωθούν ${price}.

Δεν χρειάζεται να κάνεις τίποτα — η ανανέωση είναι αυτόματη και κρατάς την πρόσβασή σου σε όλα, μαζί με την τιμή που κλείδωσες όταν μπήκες.

Αν θέλεις να σταματήσεις, απάντησε σε αυτό το email πριν από την ${renewalDate} και το κανονίζω χωρίς ερωτήσεις.

Νικόλαος${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: `Η συνδρομή σου ανανεώνεται στις ${renewalDate}`,
    text,
  });

  console.log(`Sent renewal reminder to ${email} for ${renewalDate}.`);
}

async function sendWinBackEmail({ name, email }) {
  if (!email) return;

  const discountCode = process.env.WINBACK_DISCOUNT_CODE;
  const discountLine = discountCode
    ? `\nΚαι για να σου δώσουμε ένα επιπλέον κίνητρο: χρησιμοποίησε τον κωδικό **${discountCode}** στο checkout για έκπτωση στην πρώτη ανανέωσή σου. 🎁\n`
    : '';

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Έχει περάσει περίπου ένας μήνας από τότε που έφυγες από το Lotik Shorts, και σκεφτήκαμε να σου στείλουμε ένα μικρό «γεια» — μας λείπεις στην κοινότητα!
${discountLine}
Αν θέλεις να ξαναμπείς, η πόρτα είναι πάντα ανοιχτή. Απλά κάνε μια νέα εγγραφή όποτε είσαι έτοιμος/η, και θα σε καλωσορίσουμε ξανά με χαρά.

Αν έφυγες λόγω κάποιου προβλήματος και θες να μου το πεις, απάντησε ελεύθερα σε αυτό το email.

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: discountCode ? 'Μας λείπεις! Έχουμε κάτι για σένα 🎁' : 'Μας λείπεις! 💛',
    text,
  });

  console.log(`Sent win-back email to ${email}${discountCode ? ' (with discount code)' : ''}.`);
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

// A/B test subjects for the lead auto-reply. Body stays identical — only
// the subject line varies, so any conversion-rate difference can be
// attributed to the subject alone rather than confounded with body copy
// changes too. jobs/checkLeads.js assigns a random variant per new lead
// and records it; jobs/weeklyLeadsReport.js reports conversion split by
// variant so this can be normal-course evaluated over time.
const AUTO_REPLY_SUBJECT_VARIANTS = {
  A: 'Έλαβα το ενδιαφέρον σου! 🎬',
  B: 'Το course σου είναι σχεδόν έτοιμο 👀',
};

// Used instead of the ones above once the doors are open.
const AUTO_REPLY_SUBJECT_VARIANTS_LIVE = {
  A: 'Το Lotik Shorts είναι ανοιχτό',
  B: 'Μπορείς να μπεις από σήμερα',
};

/**
 * Every lead email below is written twice: once for "the course is coming"
 * and once for "the doors are open". Flip COURSE_IS_LIVE to true in Railway
 * on launch day and both switch together — otherwise a lead who arrives the
 * morning we open is told to wait, while the launch blast tells everyone
 * else it is live.
 */
function courseIsLive() {
  return String(process.env.COURSE_IS_LIVE || '').trim().toLowerCase() === 'true';
}

function signupUrl() {
  return process.env.COURSE_SIGNUP_LINK || 'https://lotik.gr';
}

/**
 * Sends an immediate auto-reply to someone who just filled out the
 * lotik.gr lead form. The course isn't live yet, so this sets expectations
 * that they'll be notified by email once it launches, rather than
 * promising a specific follow-up timeframe.
 *
 * `variant` ('A' or 'B') picks the subject line for the ongoing A/B test —
 * defaults to 'A' if omitted/unrecognized so this never breaks callers
 * that don't pass one.
 */
async function sendLeadAutoReply({ firstName, email, variant = 'A' }) {
  if (!email) return;

  const live = courseIsLive();
  const variants = live ? AUTO_REPLY_SUBJECT_VARIANTS_LIVE : AUTO_REPLY_SUBJECT_VARIANTS;
  const subject = variants[variant] || variants.A;

  const text = live
    ? `Γεια σου${firstName ? ' ' + firstName : ''}!

Σε ευχαριστώ που συμπλήρωσες τη φόρμα. Έχω καλά νέα: το Lotik Shorts είναι ήδη ανοιχτό, οπότε δεν χρειάζεται να περιμένεις τίποτα.

Μέσα θα βρεις ολόκληρο το course — επιλογή niche, γιατί κολλάς στις προβολές, hooks και editing, monetization — και το κλειστό Discord όπου ρωτάς και απαντάω.

Η τιμή είναι €39/μήνα. Για τα πρώτα 20 μέλη είναι €29 με τον κωδικό LOTIK29 στο ταμείο, και μένει €29 για όσο είσαι μέλος.

👉 ${signupUrl()}

Αν έχεις οποιαδήποτε ερώτηση πριν μπεις, απάντησε σε αυτό το email. Το διαβάζω εγώ.

Νικόλαος`
    : `Γεια σου${firstName ? ' ' + firstName : ''}!

Σε ευχαριστώ πολύ που συμπλήρωσες τη φόρμα ενδιαφέροντος για το YouTube course μου! Έλαβα τα στοιχεία σου.

Το course βρίσκεται στα τελευταία στάδια προετοιμασίας και αναμένεται να είναι διαθέσιμο τις επόμενες ημέρες. Θα ενημερωθείς εδώ, σε αυτό το email, μόλις ανοίξουν οι εγγραφές.

Στο μεταξύ, αν έχεις οποιαδήποτε ερώτηση, μη διστάσεις να απαντήσεις σε αυτό το email.

Τα λέμε σύντομα!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject,
    text,
  });

  console.log(`Sent lead auto-reply to ${email} (variant ${variant}).`);
}

// Lightweight keyword -> tailored encouragement mapping for the nurture
// email, based on the "biggest obstacle" the lead stated on the form.
// Deliberately just a relevant, encouraging line — not a link to a real
// content library, since we don't have one wired up yet. Keeps the
// nurture email personalized without adding a whole separate email
// (avoids extra frequency/spam).
const OBSTACLE_RECOMMENDATIONS = [
  {
    keywords: ['χρόνο', 'χρονο'],
    line: 'Ξέρω ότι ο χρόνος είναι το πιο δύσκολο κομμάτι — το course είναι φτιαγμένο σε μικρά, εφαρμόσιμα βήματα ακριβώς γι\' αυτό, ώστε να προχωράς λίγο-λίγο χωρίς να χρειάζεται ώρες την ημέρα.',
  },
  {
    keywords: ['γνώσ', 'δεν ξέρω', 'δεν ξερω', 'αρχάρι', 'αρχαρι'],
    line: 'Το μεγαλύτερο μέρος των μελών μας ξεκίνησε από το μηδέν — το course χτίζεται βήμα-βήμα ακριβώς για αυτό, δεν χρειάζεται καμία προηγούμενη εμπειρία.',
  },
  {
    keywords: ['κεφάλαιο', 'κεφαλαιο', 'χρήματα', 'χρηματα', 'κόστος', 'κοστος'],
    line: 'Καταλαβαίνω πλήρως την ανησυχία για το κόστος — γι\' αυτό υπάρχει και μηνιαίο πλάνο, ώστε να ξεκινήσεις χωρίς μεγάλη αρχική δέσμευση.',
  },
  {
    keywords: ['views', 'algorithm', 'αλγόριθμο', 'αλγοριθμο'],
    line: 'Το πώς δουλεύει ο αλγόριθμος των Shorts είναι από τα πρώτα πράγματα που καλύπτουμε στο course — δεν είσαι μόνος/η σε αυτό.',
  },
];

function obstacleRecommendationLine(obstacle) {
  if (!obstacle) return '';
  const lower = obstacle.toLowerCase();
  const match = OBSTACLE_RECOMMENDATIONS.find((r) => r.keywords.some((kw) => lower.includes(kw)));
  return match ? `\n${match.line}\n` : '';
}

/**
 * Sends a follow-up "nurture" email to a lead who hasn't converted to a
 * paying subscriber a few days after filling out the form. Reflects that
 * the course is still being finalized rather than promising it's already
 * available.
 *
 * `obstacle`, if provided (the lead's own answer on the form), adds one
 * tailored, relevant line — kept to a single line so this stays a light
 * personalization touch rather than a separate content-marketing email.
 */
async function sendLeadNurtureEmail({ firstName, email, obstacle }) {
  if (!email) return;

  const recommendationLine = obstacleRecommendationLine(obstacle);

  const live = courseIsLive();

  const text = live
    ? `Γεια σου${firstName ? ' ' + firstName : ''}!

Είχες δείξει ενδιαφέρον για το Lotik Shorts και δεν σε είδα να μπαίνεις, οπότε ήθελα να επανέλθω μια φορά.
${recommendationLine}
Οι πρώτες 20 θέσεις είναι στα €29/μήνα αντί €39 με τον κωδικό LOTIK29, κλειδωμένα για όσο είσαι μέλος. Όταν πιαστούν, η τιμή γίνεται €39 για όλους.

👉 ${signupUrl()}

Αν κάτι σε κρατάει πίσω, πες μου το ευθέως σε αυτό το email — προτιμώ να ξέρω παρά να μαντεύω.

Νικόλαος${unsubscribeFooter(email)}`
    : `Γεια σου${firstName ? ' ' + firstName : ''}!

Ήθελα απλά να επανέλθω σχετικά με το ενδιαφέρον σου για το YouTube course μου. Ακόμα ετοιμάζουμε τις τελευταίες λεπτομέρειες, αλλά είσαι ήδη στη λίστα και θα σε ενημερώσω εδώ, σε αυτό το email, μόλις ανοίξουν οι εγγραφές.
${recommendationLine}
Αν έχεις οποιαδήποτε ερώτηση στο μεταξύ, απάντησε ελεύθερα σε αυτό το email — χαίρομαι πάντα να βοηθάω.

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: live
      ? 'Οι 20 θέσεις στα €29 δεν θα μείνουν ανοιχτές'
      : 'Ακόμα ετοιμάζουμε το course — να σε κρατήσω ενήμερο/η',
    text,
  });

  console.log(`Sent lead nurture email to ${email}.`);
}

/**
 * Sends the weekly leads summary email (new leads, breakdown by source,
 * conversion rate to paying subscribers) to the admin. `variantStats`,
 * if provided, is { A: { total, converted }, B: { total, converted } }
 * for the auto-reply subject-line A/B test.
 */
async function sendWeeklyLeadsReport({ totalLeads, sourceBreakdown, convertedCount, variantStats }) {
  const sourceLines = Object.entries(sourceBreakdown)
    .map(([source, count]) => `  - ${source}: ${count}`)
    .join('\n');

  const conversionRate = totalLeads > 0 ? ((convertedCount / totalLeads) * 100).toFixed(1) : '0.0';

  let variantSection = '';
  if (variantStats && (variantStats.A.total > 0 || variantStats.B.total > 0)) {
    const rate = (v) => (v.total > 0 ? ((v.converted / v.total) * 100).toFixed(1) : '0.0');
    variantSection = `

🧪 A/B test (auto-reply subject line):
  A ("${AUTO_REPLY_SUBJECT_VARIANTS.A}"): ${variantStats.A.converted}/${variantStats.A.total} (${rate(variantStats.A)}%)
  B ("${AUTO_REPLY_SUBJECT_VARIANTS.B}"): ${variantStats.B.converted}/${variantStats.B.total} (${rate(variantStats.B)}%)`;
  }

  const text = `Εβδομαδιαία σύνοψη leads (τελευταίες 7 μέρες):

📋 Νέα leads: ${totalLeads}
${sourceLines || '  (καμία πηγή)'}

✅ Έγιναν συνδρομητές: ${convertedCount} (${conversionRate}%)${variantSection}

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
/**
 * Tells the owner a new lead just came in through the lotik.gr form. Leads
 * arrive at roughly ten a day, so this leads with the two things that decide
 * whether a lead is worth a personal reply — what they said their biggest
 * obstacle is, and how much they said they can spend — instead of burying
 * them under contact details.
 */
function describeLeadSource(page) {
  const p = (page || '').toLowerCase();
  if (p.includes('utm_source=ig')) return 'Instagram (link in bio)';
  if (p.includes('fbclid')) return 'Facebook / Instagram';
  if (p) return 'Απευθείας στο lotik.gr';
  return 'Άγνωστη';
}

async function sendNewLeadAlert({ firstName, lastName, email, phone, obstacle, budget, channelStatus, page }) {
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || '(χωρίς όνομα)';

  const text = `Νέα αίτηση από το lotik.gr.

${fullName}
${email || '(χωρίς email)'}${phone ? `\n${phone}` : ''}

Πού βρίσκεται: ${channelStatus || '—'}
Διαθέσιμο κεφάλαιο: ${budget || '—'}
Προέλευση: ${describeLeadSource(page)}

Μεγαλύτερο εμπόδιο, με τα δικά του λόγια:
"${obstacle || '—'}"

Το auto-reply έχει ήδη σταλεί. Αν αξίζει προσωπική απάντηση, απάντησε απευθείας σε αυτό το email.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `🟢 Νέο lead: ${fullName}`,
    text,
    replyTo: email || ADMIN_ALERT_EMAIL,
  });

  console.log(`Sent new-lead alert for ${email || fullName}.`);
}

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

  const signupLink = signupUrl();

  const text = `Γεια σου${firstName ? ' ' + firstName : ''}!

Έχω καλά νέα: το Lotik Shorts είναι πλέον ανοιχτό.

Μιας και είχες δείξει ενδιαφέρον νωρίτερα, ήθελα να είσαι από τους πρώτους που θα το μάθουν.

👉 ${signupLink}

Αν έχεις οποιαδήποτε ερώτηση πριν εγγραφείς, απάντησε ελεύθερα σε αυτό το email.

Ανυπομονώ να σε δω μέσα!

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: 'Το course είναι πλέον διαθέσιμο! 🚀',
    text,
  });

  console.log(`Sent launch announcement to ${email}.`);
}

/**
 * Sends a gentle recovery email to someone who started the Stripe checkout
 * but abandoned it before completing payment (fired from
 * checkout.session.expired, ~24h after the session was created). Only
 * fires when Stripe actually captured an email during the abandoned
 * attempt — if they left before entering one, there's no one to email.
 */
async function sendAbandonedCheckoutEmail({ name, email }) {
  if (!email) return;

  const signupLink = process.env.COURSE_SIGNUP_LINK || 'lotik.gr';

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Παρατήρησα ότι ξεκίνησες την εγγραφή σου στο Lotik Shorts, αλλά κάτι σε σταμάτησε πριν την ολοκληρώσεις.

Αν είχες κάποια απορία ή κάτι σε μπέρδεψε στη διαδικασία, πες μου ελεύθερα — απλά απάντησε σε αυτό το email και θα σε βοηθήσω.

Αν θέλεις απλά να ξαναδοκιμάσεις:

👉 ${signupLink}

Ανυπομονώ να σε δω μέσα!

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Ξέχασες κάτι; 👀',
    text,
  });

  console.log(`Sent abandoned checkout email to ${email}.`);
}

/**
 * Sends the admin a single batched alert listing every lead flagged as
 * spam/fake in this run, with the reason for each. No-op if nothing was
 * flagged — same "quiet system is a healthy system" pattern as the audit
 * report, to avoid alert fatigue from per-lead emails.
 */
async function sendSpamLeadsAlert(flagged) {
  if (!flagged || flagged.length === 0) return;

  const lines = flagged
    .map((f) => `  - ${f.email || '(no email)'}${f.phone ? ' / ' + f.phone : ''} — ${f.reason}`)
    .join('\n');

  const text = `Το φιλτράρισμα leads βρήκε ${flagged.length} ύποπτ${flagged.length === 1 ? 'η υποβολή' : 'ές υποβολές'}, που ΔΕΝ πήραν auto-reply/nurture email:

${lines}

Αν κάποιο από αυτά είναι στην πραγματικότητα νόμιμο lead, μπορείς να αλλάξεις χειροκίνητα τη στήλη "Spam Flagged" στο sheet σε κενό ώστε να ξαναμπεί στη ροή.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `🚫 ${flagged.length} ύποπτ${flagged.length === 1 ? 'η υποβολή' : 'ές υποβολές'} φιλτραρίστηκ${flagged.length === 1 ? 'ε' : 'αν'} ως spam`,
    text,
  });

  console.log(`Sent spam leads alert for ${flagged.length} lead(s).`);
}

/**
 * Alerts the admin if the weekly email deliverability check finds the
 * bounce/complaint rate has crossed a concerning threshold — usually the
 * first sign Resend deliverability is degrading (domain reputation issue,
 * or a batch of bad addresses on recent leads). No-op if no issues.
 */
async function sendDeliverabilityAlert({ issues, totalEmails, bounceRate, complaintRate }) {
  if (!issues || issues.length === 0) return;

  const text = `Ο εβδομαδιαίος έλεγχος deliverability βρήκε πιθανό πρόβλημα (${totalEmails} emails ελέγχθηκαν):

${issues.join('\n')}

Bounce rate: ${(bounceRate * 100).toFixed(1)}%
Complaint rate: ${(complaintRate * 100).toFixed(1)}%

Έλεγξε το Resend dashboard → Emails για λεπτομέρειες ανά μήνυμα. Συνεχιζόμενο υψηλό bounce rate μπορεί να επηρεάσει τη φήμη του domain και να αρχίσουν να πηγαίνουν emails σε spam.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⚠️ Πιθανό πρόβλημα deliverability (${(bounceRate * 100).toFixed(1)}% bounce rate)`,
    text,
  });

  console.log(`Sent deliverability alert (bounce ${(bounceRate * 100).toFixed(1)}%, complaints ${(complaintRate * 100).toFixed(1)}%).`);
}

/**
 * Sends a monthly revenue/refunds summary to the accountant (or admin, if
 * no ACCOUNTANT_EMAIL is configured) — pulled straight from Stripe.
 *
 * IMPORTANT: this is an informational data summary, NOT an official tax
 * document/invoice. Greek law requires official παραστατικά (invoices/
 * receipts) to be issued through a certified system connected to myDATA —
 * this email is meant to give the accountant the raw numbers to work
 * with, not to replace that system.
 */
async function sendAccountantSummary({ monthLabel, gross, refunded, net, currency, transactionCount }) {
  const recipient = process.env.ACCOUNTANT_EMAIL || ADMIN_ALERT_EMAIL;

  const text = `Μηνιαία σύνοψη για τον λογιστή — ${monthLabel}:

💰 Μικτά έσοδα (πριν τα refunds): ${gross} ${currency}
↩️ Επιστροφές (refunds): ${refunded} ${currency}
✅ Καθαρά έσοδα: ${net} ${currency}
📊 Αριθμός επιτυχημένων συναλλαγών: ${transactionCount}

⚠️ Σημείωση: αυτή είναι μια πληροφοριακή σύνοψη δεδομένων από το Stripe, ΟΧΙ επίσημο φορολογικό παραστατικό. Για ΦΠΑ/τιμολόγηση χρησιμοποιήστε το πιστοποιημένο σας σύστημα (myDATA/ΑΑΔΕ).

— Lotik Assistant`;

  await sendEmail({
    to: recipient,
    subject: `📑 Μηνιαία σύνοψη για λογιστή — ${monthLabel}: ${net} ${currency} καθαρά`,
    text,
  });

  console.log(`Sent accountant summary for ${monthLabel} to ${recipient}.`);
}

/**
 * Alerts the admin the moment a chargeback/dispute is created, with a
 * drafted starting-point for the evidence text — built from whatever we
 * know about the customer (signup date, plan, Discord access). This is
 * explicitly a DRAFT for the admin to review/edit, never auto-submitted —
 * dispute evidence needs a human judgment call, and Stripe only allows one
 * submission per dispute.
 */
async function sendChargebackDraftAlert({ disputeId, amount, currency, reason, dueBy, customerName, customerEmail, signupDate, status, plan, discordJoined }) {
  const accessLine = discordJoined === 'Yes'
    ? 'Έχει μπει στο Discord server και είχε πρόσβαση στο περιεχόμενο.'
    : 'Δεν φαίνεται να έχει μπει ακόμα στο Discord server.';

  const draftEvidence = `Ο πελάτης (${customerName || customerEmail || 'άγνωστο όνομα'}) εγγράφηκε στις ${signupDate || 'άγνωστη ημερομηνία'} στο πλάνο "${plan || 'άγνωστο'}". ${accessLine} Η συνδρομή είναι σήμερα σε κατάσταση "${status || 'άγνωστη'}".`;

  const text = `⚠️ Νέο chargeback/dispute (${disputeId}):

Ποσό: ${amount} ${currency}
Λόγος: ${reason}
${dueBy ? `Προθεσμία υποβολής evidence: ${dueBy}` : ''}

Πελάτης: ${customerName || '(άγνωστο όνομα)'} — ${customerEmail || '(άγνωστο email)'}

📝 Προσχέδιο evidence (ΕΛΕΓΞΕ ΚΑΙ ΕΠΕΞΕΡΓΑΣΟΥ πριν το υποβάλεις — αυτό ΔΕΝ υποβάλλεται αυτόματα):

"${draftEvidence}"

Υπόβαλε το evidence χειροκίνητα από το Stripe Dashboard → Payments → Disputes, πριν την προθεσμία.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⚠️ Chargeback: ${amount} ${currency} (προθεσμία ${dueBy || 'άγνωστη'})`,
    text,
  });

  console.log(`Sent chargeback draft alert for dispute ${disputeId}.`);
}

/**
 * Daily safety-net reminder for a dispute that still needs evidence
  * submitted, sent only once its deadline is close (see
   * jobs/checkDisputeDeadlines.js). Separate from sendChargebackDraftAlert
    * above, which fires once, immediately, when the dispute is first created
     * — this is the follow-up nudge for when that first alert gets missed or
      * buried, since missing a dispute's evidence deadline means losing it
       * automatically regardless of how strong the case was.
        */
async function sendDisputeDeadlineReminder({ disputeId, amount, currency, reason, dueByLabel, daysLeft }) {
    const urgencyLine = daysLeft <= 1
      ? '🔴 Η προθεσμία λήγει ΣΗΜΕΡΑ Ή ΑΥΡΙΟ.'
          : `⚠️ Απομένουν ${daysLeft} μέρες.`;

    const text = `${urgencyLine}

    Ανοιχτό dispute (${disputeId}) χωρίς υποβεβλημένο evidence ακόμα:

    Ποσό: ${amount} ${currency}
    Λόγος: ${reason}
    Προθεσμία υποβολής evidence: ${dueByLabel}

    Αν περάσει η προθεσμία, το dispute χάνεται αυτόματα — ανεξάρτητα από το πόσο δυνατή θα ήταν η υπόθεσή σου.

    Υπόβαλε evidence τώρα: Stripe Dashboard → Payments → Disputes → ${disputeId}

    — Lotik Assistant`;

    await sendEmail({
          to: ADMIN_ALERT_EMAIL,
          subject: `${daysLeft <= 1 ? '🔴 ΕΠΕΙΓΟΝ' : '⚠️'} Dispute deadline σε ${daysLeft} μέρες: ${amount} ${currency}`,
          text,
    });

    console.log(`Sent dispute deadline reminder for ${disputeId} (${daysLeft} day(s) left).`);
}

/**
 * Alerts the admin if the weekly refund-rate check finds the rate of
 * refunded charges has crossed a concerning threshold over the lookback
 * window — often the first sign of a quality/expectations problem, or a
 * technical issue causing accidental duplicate charges.
 */
async function sendRefundRateAlert({ refundRate, refundedCount, totalCharges, lookbackDays }) {
  const text = `⚠️ Το ποσοστό refunds τις τελευταίες ${lookbackDays} μέρες είναι ασυνήθιστα υψηλό:

${refundedCount}/${totalCharges} συναλλαγές (${(refundRate * 100).toFixed(1)}%) έχουν refund.

Αυτό μπορεί να σημαίνει πρόβλημα ποιότητας/προσδοκιών, ή κάποιο technical issue (π.χ. διπλές χρεώσεις). Καλό θα ήταν να το ελέγξεις.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⚠️ Υψηλό ποσοστό refunds: ${(refundRate * 100).toFixed(1)}%`,
    text,
  });

  console.log(`Sent refund rate alert (${(refundRate * 100).toFixed(1)}%).`);
}

/**
 * Sends a retention "save offer" email the moment someone schedules their
 * subscription to cancel at period end (via the Stripe Customer Portal).
 * If SAVE_OFFER_DISCOUNT_CODE is set, offers a discount to stay. If the
 * customer has been subscribed 2+ months AND DOWNSELL_PLAN_LINK is set,
 * also offers a cheaper plan as an alternative to leaving entirely.
 */
async function sendSaveOfferEmail({ name, email, eligibleForDownsell }) {
  if (!email) return;

  const saveCode = process.env.SAVE_OFFER_DISCOUNT_CODE;
  const downsellLink = process.env.DOWNSELL_PLAN_LINK;

  const discountLine = saveCode
    ? `Πριν φύγεις, ήθελα να σου προσφέρω κάτι: χρησιμοποίησε τον κωδικό **${saveCode}** στην επόμενη ανανέωσή σου, αν αποφασίσεις να μείνεις. 🎁`
    : '';

  const downsellLine = eligibleForDownsell && downsellLink
    ? `\n\nΕναλλακτικά, αν το θέμα είναι το κόστος, έχουμε και ένα πιο οικονομικό πλάνο — ρίξε μια ματιά εδώ: ${downsellLink}`
    : '';

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Είδα ότι προγραμμάτισες την ακύρωση της συνδρομής σου στο Lotik Shorts — λυπάμαι που φεύγεις!

${discountLine}${downsellLine}

Αν κάτι δεν πήγε καλά ή αν έχεις κάποιο feedback, θα μου άρεσε πολύ να το ακούσω — απλά απάντησε σε αυτό το email.

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: 'Πριν φύγεις... 🥺',
    text,
  });

  console.log(`Sent save offer email to ${email} (downsell offered: ${eligibleForDownsell}).`);
}

/**
 * Sends a "consider going yearly" upsell email to Monthly-plan subscribers
 * once they've had time to experience real value. Sent once per person,
 * tracked via the "Upsell Sent" sheet column.
 */
async function sendUpsellEmail({ name, email }) {
  if (!email) return;

  const upgradeLink = process.env.UPGRADE_TO_YEARLY_LINK || process.env.COURSE_SIGNUP_LINK || 'lotik.gr';

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Ελπίζω να απολαμβάνεις το Lotik Shorts μέχρι στιγμής! Ήθελα απλά να σου πω ότι υπάρχει και ετήσιο πλάνο, που σου βγαίνει πιο συμφέρον μακροπρόθεσμα σε σχέση με τη μηνιαία χρέωση.

👉 ${upgradeLink}

Αν έχεις οποιαδήποτε ερώτηση σχετικά, απάντησε ελεύθερα σε αυτό το email.

Με εκτίμηση,
Lotik${unsubscribeFooter(email)}`;

  await sendEmail({
    to: email,
    subject: 'Ένα μικρό tip για το πλάνο σου 💡',
    text,
  });

  console.log(`Sent upsell email to ${email}.`);
}

/**
 * Sends a reminder for an upcoming live event (Q&A/webinar) to the admin's
 * configured channel-facing recipient — actually posted via Discord in
 * jobs/checkEventReminders.js, this email version is a fallback/parallel
 * channel so the admin also has a record. `label` is "24 ώρες", "1 ώρα",
 * or "10 λεπτά".
 */
async function sendEventReminderEmail({ eventName, label, dateTime, description, link }) {
  const text = `⏰ Υπενθύμιση: το "${eventName}" ξεκινάει σε ${label}!

${description || ''}
${link ? `\n👉 ${link}\n` : ''}
Ώρα εκδήλωσης: ${dateTime}

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `⏰ "${eventName}" σε ${label}`,
    text,
  });

  console.log(`Sent event reminder email (${label}) for "${eventName}".`);
}

/**
 * Sends the weekly SOP (standard operating procedure) checklist reminder
 * — a fixed list of recurring admin tasks read from the "SOP" sheet tab,
 * so the admin can edit the list without touching code. No-op if the tab
 * is empty/doesn't exist yet.
 */
async function sendSopReminder(tasks) {
  if (!tasks || tasks.length === 0) return;

  const lines = tasks.map((t, i) => `${i + 1}. ${t}`).join('\n');

  const text = `Εβδομαδιαία υπενθύμιση επαναλαμβανόμενων εργασιών:

${lines}

(Μπορείς να επεξεργαστείς αυτή τη λίστα στο tab "SOP" του Google Sheet.)

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `📋 Εβδομαδιαία SOP υπενθύμιση (${tasks.length} εργασίες)`,
    text,
  });

  console.log(`Sent SOP reminder with ${tasks.length} task(s).`);
}

/**
 * Sends the monthly "wins" digest — a list of links to everyone who
 * posted in the #wins channel that month, so the admin can browse/share
 * highlights. This links to each post rather than summarizing its
 * content, since the bot can't read message text (no Message Content
 * intent). No-op if nobody posted.
 */
async function sendWinsDigest({ monthLabel, wins }) {
  if (!wins || wins.length === 0) {
    console.log(`Wins digest: no wins logged for ${monthLabel}, skipping email.`);
    return;
  }

  const lines = wins.map((w) => `  - ${w.author} (${w.date}): ${w.link}`).join('\n');

  const text = `🎉 Μηνιαία σύνοψη wins — ${monthLabel} (${wins.length} post${wins.length === 1 ? '' : 's'}):

${lines}

Ρίξε μια ματιά και σκέψου ποιο θα ήταν καλό testimonial/case study υλικό!

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `🎉 Μηνιαία σύνοψη wins — ${monthLabel} (${wins.length})`,
    text,
  });

  console.log(`Sent wins digest for ${monthLabel} (${wins.length} win(s)).`);
}

/**
 * Sends a legal-notice email informing an active subscriber that the
 * Terms of Service and/or Privacy Policy were updated. This is a
 * transactional/legal notice, not marketing — it always sends regardless
 * of the "Unsubscribed" flag, since it's an operational notice about the
 * contract terms of an active subscription, not a promotional message.
 */
async function sendTermsUpdateEmail({ name, email }) {
  if (!email) return;

  const termsUrl = process.env.TERMS_URL;
  const privacyUrl = process.env.PRIVACY_POLICY_URL;
  const linksLine = [
    termsUrl ? `Όροι Χρήσης: ${termsUrl}` : null,
    privacyUrl ? `Πολιτική Απορρήτου: ${privacyUrl}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Θέλαμε να σε ενημερώσουμε ότι ενημερώσαμε τους Όρους Χρήσης ${privacyUrl ? 'και/ή την Πολιτική Απορρήτου ' : ''}του Lotik Shorts.
${linksLine ? `\n${linksLine}\n` : ''}
Η συνέχιση της χρήσης της υπηρεσίας μετά από αυτή την ενημέρωση σημαίνει ότι αποδέχεσαι τους ενημερωμένους όρους. Αν έχεις οποιαδήποτε ερώτηση, απάντησε ελεύθερα σε αυτό το email.

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: 'Ενημέρωση Όρων Χρήσης / Πολιτικής Απορρήτου',
    text,
  });

  console.log(`Sent terms update notice to ${email}.`);
}

/**
 * Alerts the admin immediately when the app hits an uncaught exception or
 * unhandled promise rejection — the clearest reliable signal from inside
 * the process that something critical broke. Includes a short runbook so
 * whoever sees the alert knows the first steps to take.
 */
async function sendIncidentAlert({ errorType, message, stack }) {
  const text = `🚨 Κρίσιμο σφάλμα: το bot μόλις αντιμετώπισε ${errorType}.

Μήνυμα: ${message}

${stack ? `Stack trace (πρώτες γραμμές):\n${(stack || '').split('\n').slice(0, 8).join('\n')}\n` : ''}
📋 Πρώτα βήματα:
1. Έλεγξε τα Railway logs για το πλήρες stack trace.
2. Αν η υπηρεσία έχει σταματήσει να ανταποκρίνεται, το Railway συνήθως την επανεκκινεί αυτόματα — επιβεβαίωσε ότι το deployment status είναι πάλι "SUCCESS".
3. Αν το σφάλμα επαναλαμβάνεται, έλεγξε το τελευταίο commit/deploy για πιθανή αιτία.
4. Αν αφορά εξωτερικό service (Stripe, Google Sheets, Discord, Resend), έλεγξε αν έχει status incident.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `🚨 Κρίσιμο σφάλμα: ${errorType}`,
    text,
  });

  console.log(`Sent incident alert (${errorType}).`);
}

/**
 * Alerts the admin when the weekly backup was created but failed its own
  * restore-sanity check (see lib/backup.js verifyBackup) — i.e. the backup
   * file exists, but reading it back shows it's missing a tab or has
    * noticeably fewer rows than the live sheet. Meant to be found and fixed
     * calmly during the week it happens, rather than discovered the day an
      * actual restore is needed.
       */
async function sendBackupVerificationAlert({ missingTabs, liveRowCount, backupRowCount }) {
    const issues = [];
    if (missingTabs.length > 0) {
          issues.push(`Λείπουν tabs από το backup: ${missingTabs.join(', ')}`);
    }
    if (backupRowCount < liveRowCount - 1) {
          issues.push(`Το backup έχει ${backupRowCount} γραμμές έναντι ${liveRowCount} στο ζωντανό sheet — φαίνεται ελλιπές.`);
    }

    const text = `⚠️ Το εβδομαδιαίο backup δημιουργήθηκε, αλλά ο αυτόματος έλεγχος βρήκε πρόβλημα:

    ${issues.map((i) => `• ${i}`).join('\n')}

    Αυτό σημαίνει ότι αν χρειαστεί ποτέ πραγματική επαναφορά, αυτό συγκεκριμένα το backup μπορεί να μην είναι αξιόπιστο. Έλεγξε το χειροκίνητα στο Google Drive, και αν χρειαστεί, τρέξε ξανά το backup.

    — Lotik Assistant`;

    await sendEmail({
          to: ADMIN_ALERT_EMAIL,
          subject: `⚠️ Το backup απέτυχε στον έλεγχο επαναφοράς`,
          text,
    });

    console.log('Sent backup verification alert.');
}

/**
 * Alerts the admin when lotik.gr's uptime status changes (goes down, or
 * recovers after being down). `status` is 'down' or 'recovered'.
 */
async function sendUptimeAlert({ url, status, statusCode }) {
  const isDown = status === 'down';
  const text = isDown
    ? `🔴 Το ${url} φαίνεται να είναι εκτός λειτουργίας${statusCode ? ` (HTTP ${statusCode})` : ' (δεν απάντησε)'}.

Καλό θα ήταν να το ελέγξεις άμεσα.

— Lotik Assistant`
    : `🟢 Το ${url} επανήλθε σε λειτουργία.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: isDown ? `🔴 Το ${url} είναι εκτός λειτουργίας!` : `🟢 Το ${url} επανήλθε`,
    text,
  });

  console.log(`Sent uptime alert (${status}) for ${url}.`);
}

/**
 * Alerts the admin about one or more tool subscriptions renewing soon
 * (see jobs/checkToolRenewals.js). `renewals` is an array of
 * { tool, cost, currency, renewalDate, daysUntil }, batched into one
 * email so a week with several renewals coming up doesn't mean several
 * separate emails.
 */
async function sendToolRenewalAlert({ renewals }) {
  const lines = renewals.map((r) => {
    const costPart = r.cost ? ` (${r.cost}${r.currency ? ` ${r.currency}` : ''})` : '';
    const when = r.daysUntil <= 0 ? 'σήμερα' : `σε ${r.daysUntil} μέρες (${r.renewalDate})`;
    return `• ${r.tool}${costPart} — ανανεώνεται ${when}`;
  });

  const text = `💳 Οι παρακάτω συνδρομές εργαλείων ανανεώνονται σύντομα:

${lines.join('\n')}

Έλεγξε αν χρειάζεται να ακυρωθεί κάποια πριν χρεωθεί ξανά.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: renewals.length === 1
      ? `💳 1 συνδρομή εργαλείου ανανεώνεται σύντομα`
      : `💳 ${renewals.length} συνδρομές εργαλείων ανανεώνονται σύντομα`,
    text,
  });

  console.log(`Sent tool renewal alert for ${renewals.length} tool(s).`);
}

/**
 * Alerts the admin about one or more open support tickets that have gone
 * past the SLA window (see jobs/checkTicketSLA.js) without a first reply
 * from support. `tickets` is an array of { channelName, channelId,
 * hoursOpen }, batched into one email.
 */
async function sendTicketSLAAlert({ tickets, slaHours }) {
  const lines = tickets.map((t) => `• #${t.channelName} — ανοιχτό ${t.hoursOpen} ώρες χωρίς απάντηση`);

  const text = `⏰ Τα παρακάτω tickets υποστήριξης είναι ανοιχτά πάνω από ${slaHours} ώρες χωρίς απάντηση από support:

${lines.join('\n')}

Ρίξε μια ματιά όσο πιο σύντομα γίνεται.

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: tickets.length === 1
      ? `⏰ 1 ticket υποστήριξης χωρίς απάντηση`
      : `⏰ ${tickets.length} tickets υποστήριξης χωρίς απάντηση`,
    text,
  });

  console.log(`Sent ticket SLA alert for ${tickets.length} ticket(s).`);
}

/**
 * Alerts the admin about a new online mention found via the Google Alerts
 * RSS feed (GOOGLE_ALERTS_RSS_URL).
 */
async function sendMentionAlert({ title, link }) {
  const text = `👀 Νέα αναφορά βρέθηκε online:

${title}
${link}

— Lotik Assistant`;

  await sendEmail({
    to: ADMIN_ALERT_EMAIL,
    subject: `👀 Νέα αναφορά: ${title}`,
    text,
  });

  console.log(`Sent mention alert: ${title}`);
}

/**
 * Sends the replay link for a live event to someone who didn't attend.
 */
async function sendReplayEmail({ name, email, eventName, link }) {
  if (!email) return;

  const text = `Γεια σου${name ? ' ' + name.split(' ')[0] : ''}!

Είδαμε ότι δεν κατάφερες να παρευρεθείς στο "${eventName}" — μη σου χαλάσει, εδώ είναι το replay:

👉 ${link}

Με εκτίμηση,
Lotik`;

  await sendEmail({
    to: email,
    subject: `📼 Replay: ${eventName}`,
    text,
  });

  console.log(`Sent replay email for "${eventName}" to ${email}.`);
}

module.exports = {
  sendWelcomeEmail,
  sendNewLeadAlert,
  describeLeadSource,
  sendRenewalReminderEmail,
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
  sendSpamLeadsAlert,
  sendMonthlyReport,
  sendCohortReport,
  sendCheckInEmail,
  sendAbandonedCheckoutEmail,
  sendDeliverabilityAlert,
  sendAccountantSummary,
  sendChargebackDraftAlert,
    sendDisputeDeadlineReminder,
  sendRefundRateAlert,
  sendSaveOfferEmail,
  sendUpsellEmail,
  sendEventReminderEmail,
  sendSopReminder,
  sendWinsDigest,
  sendTermsUpdateEmail,
  sendIncidentAlert,
    sendBackupVerificationAlert,
  sendUptimeAlert,
  sendToolRenewalAlert,
  sendTicketSLAAlert,
  sendMentionAlert,
  sendReplayEmail,
  sendTestimonialRequestEmail,
};
