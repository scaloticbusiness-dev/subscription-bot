// jobs/weeklyLeadsReport.js
// Runs once a week. Summarizes the last 7 days of leads from the leads
// sheet: how many, broken down by traffic source (parsed from the page
// link), and how many have since become paying subscribers.

const { getAllLeads } = require('../lib/leads');
const { findRowByEmail } = require('../lib/sheets');
const { sendWeeklyLeadsReport } = require('../lib/email');

function daysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Rough traffic-source classification based on the tracking params present
 * in the page link the lead came from.
 */
function classifySource(page) {
  if (!page) return 'Άγνωστη';
  if (page.includes('utm_source=ig')) return 'Instagram Bio';
  if (page.includes('fbclid')) return 'Facebook';
  return 'Άλλο / Direct';
}

async function generateWeeklyLeadsReport() {
  console.log(`[${new Date().toISOString()}] Running weekly leads report...`);

  if (!process.env.GOOGLE_LEADS_SHEET_ID) {
    return;
  }

  const leads = await getAllLeads();
  const recentLeads = leads.filter((l) => {
    const days = daysSince(l.date);
    return days !== null && days <= 7;
  });

  const sourceBreakdown = {};
  let convertedCount = 0;

  for (const lead of recentLeads) {
    const source = classifySource(lead.page);
    sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

    try {
      const converted = lead.email ? await findRowByEmail(lead.email) : null;
      if (converted) convertedCount += 1;
    } catch (err) {
      console.error(`Failed to check conversion for ${lead.email}:`, err.message);
    }
  }

  await sendWeeklyLeadsReport({
    totalLeads: recentLeads.length,
    sourceBreakdown,
    convertedCount,
  });

  console.log(`Weekly leads report sent: ${recentLeads.length} leads, ${convertedCount} converted.`);
}

module.exports = { generateWeeklyLeadsReport };
