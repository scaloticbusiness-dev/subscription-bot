// jobs/monthlyWinsDigest.js
// Runs on the 1st of each month (bundled with the other monthly jobs).
// Reads the "Wins Log" tab (populated live by lib/discordGateway.js as
// people post in the wins channel) for the previous calendar month and
// emails a digest of links — not a content summary, since the bot can't
// read message text without the Message Content intent.

const { getWinsInRange } = require('../lib/wins');
const { sendWinsDigest } = require('../lib/email');

function monthRange(monthsAgo) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  return {
    startStr: start.toISOString().slice(0, 10),
    endStr: end.toISOString().slice(0, 10),
    label: start.toLocaleDateString('el-GR', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

async function generateWinsDigest() {
  console.log(`[${new Date().toISOString()}] Running monthly wins digest job...`);

  const range = monthRange(1);
  const wins = await getWinsInRange(range.startStr, range.endStr);

  await sendWinsDigest({ monthLabel: range.label, wins });

  console.log(`Wins digest job complete for ${range.label} (${wins.length} win(s)).`);
}

module.exports = { generateWinsDigest };
