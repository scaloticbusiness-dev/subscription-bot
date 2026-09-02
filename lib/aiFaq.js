// lib/aiFaq.js
// AI fallback for the /faq command. When the plain keyword match in
// lib/faq.js finds nothing, this asks Claude (Anthropic's Messages API,
// called directly via fetch — same "no extra SDK" approach as
// lib/transcription.js's AssemblyAI integration) to answer instead,
// grounded in the same "FAQ" sheet so it doesn't just make things up.
//
// Requires ANTHROPIC_API_KEY. Model is configurable via AI_FAQ_MODEL,
// defaulting to a small/fast Claude model since these are short,
// low-stakes community-support answers, not anything that needs deep
// reasoning.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const MAX_ANSWER_CHARS = 1900; // stays under Discord's 2000-char message limit with room to spare

/**
 * Builds the grounding context from the existing FAQ sheet rows, so the AI
 * prefers the community's own known answers over guessing.
 */
function buildKnownAnswersBlock(faqs) {
  if (!faqs || faqs.length === 0) return '(Δεν υπάρχουν ακόμα καταχωρημένες απαντήσεις στο FAQ sheet.)';
  return faqs
    .map((faq) => `- Θέμα (${faq.keywords.join(', ')}): ${faq.answerEl}`)
    .join('\n');
}

/**
 * Asks Claude to answer `question`, grounded in the existing FAQ sheet
 * rows. Returns the answer text (trimmed to fit a Discord message).
 * Throws on any failure (missing API key, network/API error, empty
 * response) so the caller can fall back to the existing "no answer found"
 * message.
 */
async function generateAiFaqAnswer({ question, lang, faqs }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured.');
  }

  const languageInstruction = lang === 'en' ? 'Απάντησε στα Αγγλικά.' : 'Απάντησε στα Ελληνικά.';
  const systemPrompt = `Είσαι ο "Lotik Assistant", ένα φιλικό support bot στο Discord server μιας online κοινότητας/course (Lotik Shorts). Ένα μέλος έκανε μια ερώτηση στην εντολή /faq που δεν ταίριαξε με καμία ήδη καταχωρημένη λέξη-κλειδί.

Παρακάτω είναι οι ήδη γνωστές απαντήσεις της κοινότητας (θεωρείς αυτές ως πηγή αλήθειας — αν κάτι από αυτά καλύπτει την ερώτηση, χρησιμοποίησέ το ή παραφράσε το, μην το αγνοήσεις):

${buildKnownAnswersBlock(faqs)}

Οδηγίες:
- ${languageInstruction}
- Κράτα την απάντηση σύντομη (2-4 προτάσεις), φιλική και χρήσιμη.
- Μην επινοείς συγκεκριμένα στοιχεία (τιμές, ημερομηνίες, links, όρους) που δεν βρίσκονται στις παραπάνω γνωστές απαντήσεις.
- Αν η ερώτηση χρειάζεται συγκεκριμένα στοιχεία λογαριασμού/πληρωμής που δεν έχεις, ή αν πραγματικά δεν ξέρεις, πες το ειλικρινά και πρότεινε στο μέλος να ρωτήσει ελεύθερα στο κανάλι ώστε να το δει κάποιος από την ομάδα.
- Μην υπογράφεις την απάντηση, μην προσθέτεις emoji υπερβολικά.`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.AI_FAQ_MODEL || DEFAULT_MODEL,
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: question }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const answer = (data.content || []).map((block) => block.text || '').join('').trim();
  if (!answer) {
    throw new Error('Anthropic API returned an empty answer.');
  }

  if (answer.length > MAX_ANSWER_CHARS) {
    return `${answer.slice(0, MAX_ANSWER_CHARS)}…`;
  }
  return answer;
}

module.exports = { generateAiFaqAnswer };
