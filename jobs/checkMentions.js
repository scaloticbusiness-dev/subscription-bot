// jobs/checkMentions.js
// Runs once a day. Polls the RSS feed URL configured via
// GOOGLE_ALERTS_RSS_URL (set up a free Google Alert for your brand name
// with "Deliver to: RSS feed" instead of email) and alerts the admin
// about any items not already logged. No paid monitoring API needed.
//
// RSS parsing here is intentionally simple (regex-based) rather than
// pulling in a new dependency — Google Alerts' feed format is stable and
// well-formed enough for this.

const { ensureMentionsLogSheet, getSeenLinks, logMention } = require('../lib/mentions');
const { sendMentionAlert } = require('../lib/email');

function stripHtml(str) {
  return (str || '').replace(/<[^>]*>/g, '').trim();
}

function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<entry>([\s\S]*?)<\/entry>/g; // Google Alerts uses Atom format (<entry>), not classic RSS <item>
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link[^>]*href="([^"]*)"/);
    if (titleMatch && linkMatch) {
      items.push({ title: stripHtml(titleMatch[1]), link: linkMatch[1] });
    }
  }
  return items;
}

async function checkMentions() {
  console.log(`[${new Date().toISOString()}] Running mentions check...`);

  const feedUrl = process.env.GOOGLE_ALERTS_RSS_URL;
  if (!feedUrl) {
    console.log('GOOGLE_ALERTS_RSS_URL not set — skipping mentions check.');
    return;
  }

  try {
    await ensureMentionsLogSheet();
  } catch (err) {
    console.error('Could not verify/create the Mentions Log tab:', err.message);
    return;
  }

  let items;
  try {
    const res = await fetch(feedUrl);
    if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
    const xml = await res.text();
    items = parseRssItems(xml);
  } catch (err) {
    console.error('Failed to fetch/parse Google Alerts RSS feed:', err.message);
    return;
  }

  const seenLinks = await getSeenLinks();
  const newItems = items.filter((item) => !seenLinks.has(item.link));

  let sentCount = 0;
  for (const item of newItems) {
    try {
      await sendMentionAlert(item);
      await logMention(item);
      sentCount += 1;
    } catch (err) {
      console.error(`Failed to process mention "${item.title}":`, err.message);
    }
  }

  console.log(`Mentions check complete. ${sentCount} new mention(s) alerted.`);
}

module.exports = { checkMentions };
