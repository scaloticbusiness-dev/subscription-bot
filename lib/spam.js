// lib/spam.js
// Post-hoc spam/fake-lead detection for the leads sheet. The lead form
// itself lives on lotik.gr (outside this repo), so real pre-submission
// rate limiting isn't possible from here — instead, checkLeads.js runs
// these checks on every new row and flags anything suspicious before an
// auto-reply/nurture email would otherwise go out.

// Common disposable/temp-mail domains. Not exhaustive — just the
// well-known ones that show up in spam/bot submissions. Extend as needed.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  '10minutemail.net',
  'tempmail.com',
  'temp-mail.org',
  'yopmail.com',
  'trashmail.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'getnada.com',
  'sharklasers.com',
  'maildrop.cc',
  'dispostable.com',
  'mintemail.com',
  'mailnesia.com',
]);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * True if the address is malformed or from a known disposable-email domain.
 */
function isDisposableOrMalformedEmail(email) {
  if (!email) return false;
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return true;

  const domain = trimmed.split('@')[1];
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

/**
 * True if the local part of the email looks obviously fake/keyboard-mash
 * rather than a real name-based address — e.g. "asdf@x.com",
 * "test123@x.com", "aaaaaa@x.com", or a local part with no vowels at all
 * (very unlikely for a real word in Greek or English).
 */
function looksLikeFakeLocalPart(email) {
  if (!email) return false;
  const local = email.trim().toLowerCase().split('@')[0];
  if (!local) return true;

  const FAKE_WORDS = ['test', 'asdf', 'qwerty', 'fake', 'spam', 'xxx', 'aaaa', 'sample', 'example', 'noreply', 'foo', 'bar'];
  if (FAKE_WORDS.some((w) => local === w || local.startsWith(w))) return true;

  // Same character repeated through most of the string (e.g. "aaaaaaa").
  if (/^(.)\1{3,}$/.test(local)) return true;

  // No vowels at all (Latin or Greek) and length > 3 — very unlikely to be
  // a real word/name in either language.
  const hasVowel = /[aeiouαεηιουω]/i.test(local);
  if (!hasVowel && local.replace(/[^a-zα-ω]/gi, '').length > 3) return true;

  return false;
}

/**
 * Parses a lead's date field as a full Date (falls back gracefully if the
 * value is date-only with no time component).
 */
function parseLeadTimestamp(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Detects a burst of submissions sharing the same email or phone within a
 * short window (default 10 minutes) — the signature of a bot/spam script
 * hammering the form rather than a real person resubmitting. Returns the
 * matching prior lead if this looks like part of a burst, or null.
 */
function findBurstDuplicate(lead, allLeads, windowMinutes = 10) {
  const ts = parseLeadTimestamp(lead.date);
  if (!ts) return null;

  return (
    allLeads.find((other) => {
      if (other.rowNumber === lead.rowNumber) return false;
      const otherTs = parseLeadTimestamp(other.date);
      if (!otherTs) return false;

      const withinWindow = Math.abs(ts.getTime() - otherTs.getTime()) <= windowMinutes * 60 * 1000;
      if (!withinWindow) return false;

      const sameEmail = lead.email && other.email && lead.email.toLowerCase() === other.email.toLowerCase();
      const samePhone = lead.phone && other.phone && lead.phone === other.phone;
      return sameEmail || samePhone;
    }) || null
  );
}

/**
 * Full spam check for a single lead. Returns { spam: false } or
 * { spam: true, reason: string }.
 */
function evaluateLead(lead, allLeads) {
  if (isDisposableOrMalformedEmail(lead.email)) {
    return { spam: true, reason: 'Άκυρο ή προσωρινό (disposable) email' };
  }
  if (looksLikeFakeLocalPart(lead.email)) {
    return { spam: true, reason: 'Το email μοιάζει προφανώς ψεύτικο' };
  }
  const burst = findBurstDuplicate(lead, allLeads);
  if (burst) {
    return { spam: true, reason: `Πολλαπλές υποβολές σε σύντομο διάστημα (ίδιο email/τηλέφωνο με row ${burst.rowNumber})` };
  }
  return { spam: false };
}

module.exports = {
  isDisposableOrMalformedEmail,
  looksLikeFakeLocalPart,
  findBurstDuplicate,
  evaluateLead,
};
