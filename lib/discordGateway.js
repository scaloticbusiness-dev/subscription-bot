// lib/discordGateway.js
// Keeps a live (websocket) connection to Discord so we can react the moment
// someone joins the server — this is different from the simple REST calls
// used elsewhere, which only work request/response style.
//
// On every new member:
//   1. Sends a welcome message in the configured channel
//   2. Marks "Discord Joined" = Yes on their sheet row, if one exists
//   3. Checks Google Sheets: if this Discord username already has an
//      Active, non-expired subscription (e.g. they left and rejoined),
//      automatically gives them the "winner" role back (plus the VIP role
//      if they're on a yearly plan) and refreshes the row with their
//      (possibly new) Discord user ID.
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { findRowByDiscordUsername, updateRow } = require('./sheets');
const { isExpired } = require('../jobs/checkExpiredSubscriptions');
const { addRoleToUser } = require('./discord');
const WELCOME_MESSAGE_TEMPLATE = `👋 Καλωσόρισες στο community, {mention}!

Χαιρόμαστε πολύ που είσαι μαζί μας. Να μερικά πρώτα βήματα:

📜 Ρίξε μια ματιά στους κανόνες μας στο #rules
💬 Πες ένα «γεια» στο #general
❓ Μη διστάσεις να επικοινωνήσεις μαζί μας αν έχεις οποιαδήποτε απορία!`;
let client = null;
function buildClient() {
  const c = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.GuildMember],
  });
  c.once('ready', () => {
    console.log(`Discord gateway connected as ${c.user.tag}`);
  });
  c.on('guildMemberAdd', async (member) => {
    try {
      await sendWelcomeMessage(member);
    } catch (err) {
      console.error('Failed to send welcome message:', err.message);
    }
    try {
      await markDiscordJoined(member);
    } catch (err) {
      console.error('Failed to mark Discord Joined on sheet:', err.message);
    }
    try {
      await restoreRoleIfReturningSubscriber(member);
    } catch (err) {
      console.error('Failed to check/restore role for returning member:', err.message);
    }
  });
  c.on('error', (err) => {
    console.error('Discord gateway error:', err.message);
  });
  return c;
}
async function sendWelcomeMessage(member) {
  const channelId = process.env.WELCOME_CHANNEL_ID;
  if (!channelId) {
    console.warn('WELCOME_CHANNEL_ID not set — skipping welcome message.');
    return;
  }
  const channel = await member.guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    console.error(`Welcome channel ${channelId} not found or not text-based.`);
    return;
  }
  const text = WELCOME_MESSAGE_TEMPLATE.replace('{mention}', `<@${member.id}>`);
  await channel.send(text);
  console.log(`Sent welcome message to ${member.user.username}`);
}
/**
 * Marks "Discord Joined" = Yes on this member's sheet row, if they have one
 * (i.e. they've already paid and their Discord username is on file). Safe
 * no-op if there's no matching row — e.g. someone joins the server without
 * ever having subscribed.
 */
async function markDiscordJoined(member) {
  const username = member.user.username;
  const row = await findRowByDiscordUsername(username);
  if (!row) return;
  if (row.discordJoined === 'Yes') return; // already marked, avoid a needless write
  await updateRow(row.rowNumber, { discordJoined: 'Yes' });
  console.log(`Marked Discord Joined = Yes for ${username}`);
}
async function restoreRoleIfReturningSubscriber(member) {
  const username = member.user.username;
  const row = await findRowByDiscordUsername(username);
  if (!row) return; // never subscribed, nothing to restore
  const stillActive = row.status.toLowerCase() === 'active' && !isExpired(row.renewalDate);
  if (!stillActive) return; // subscription lapsed, don't restore
  await addRoleToUser(member.id);
  console.log(`Restored "winner" role for returning subscriber ${username}`);

  // Also restore the VIP role if they're on a yearly plan.
  if (row.plan && row.plan.includes('Yearly') && process.env.DISCORD_VIP_ROLE_ID) {
    await addRoleToUser(member.id, process.env.DISCORD_VIP_ROLE_ID);
    console.log(`Restored VIP role for returning yearly subscriber ${username}`);
  }

  // Keep the row's Discord username field accurate in case anything changed.
  await updateRow(row.rowNumber, { discordUsername: username });
}
/**
 * Starts the Discord gateway connection. Safe to call once at startup.
 */
async function startDiscordGateway() {
  if (client) return client;
  client = buildClient();
  await client.login(process.env.DISCORD_BOT_TOKEN);
  return client;
}
module.exports = { startDiscordGateway };
