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
const { Client, GatewayIntentBits, Partials, PermissionFlagsBits } = require('discord.js');
const { findRowByDiscordUsername, updateRow } = require('./sheets');
const { isExpired } = require('../jobs/checkExpiredSubscriptions');
const { addRoleToUser } = require('./discord');
const { loadFaqs, findMatch, answerForLanguage } = require('./faq');
const { ensureWinsLogSheet, logWin } = require('./wins');
function buildWelcomeMessage(mention) {
  const videoLine = process.env.WELCOME_VIDEO_LINK
    ? `\n\n🎬 Πριν κάνεις οτιδήποτε άλλο, δες αυτό το σύντομο βίντεο — εξηγεί πού είναι τα πάντα (μαθήματα στο Skool, κλήσεις εδώ στο Discord):\n${process.env.WELCOME_VIDEO_LINK}`
    : '';

  return `👋 Καλωσόρισες στο community, ${mention}!

Χαιρόμαστε πολύ που είσαι μαζί μας. Να μερικά πρώτα βήματα:

📜 Ρίξε μια ματιά στους κανόνες μας στο #rules
💬 Πες ένα «γεια» στο #general
❓ Μη διστάσεις να επικοινωνήσεις μαζί μας αν έχεις οποιαδήποτε απορία!${videoLine}`;
}

// In-memory debounce for activity tracking: only write to the sheet once
// per hour per username, even if someone is chatting constantly. Resets on
// every deploy/restart, which just means the next message after a restart
// writes once more than strictly necessary — harmless.
const activityDebounce = new Map();
const ACTIVITY_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour

let client = null;
function buildClient() {
  const c = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.GuildMember],
  });
  c.once('ready', async () => {
    console.log(`Discord gateway connected as ${c.user.tag}`);
    try {
      await registerSlashCommands(c);
    } catch (err) {
      console.error('Failed to register slash commands:', err.message);
    }
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
  c.on('messageCreate', async (message) => {
    try {
      if (message.author.bot) return;
      if (!message.guildId) return; // ignore DMs sent to the bot itself
      await trackActivity(message.author.username);
    } catch (err) {
      console.error('Failed to track Discord activity:', err.message);
    }
    try {
      if (message.author.bot) return;
      await trackWinsChannelPost(message);
    } catch (err) {
      console.error('Failed to log wins channel post:', err.message);
    }
  });
  c.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === 'faq') {
        await handleFaqCommand(interaction);
      } else if (interaction.commandName === 'announce-lesson') {
        await handleAnnounceLessonCommand(interaction);
      }
    } catch (err) {
      console.error(`Failed to handle /${interaction.commandName} command:`, err.message);
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
  const text = buildWelcomeMessage(`<@${member.id}>`);
  await channel.send(text);
  console.log(`Sent welcome message to ${member.user.username}`);
}
/**
 * Registers both global slash commands (/faq and /announce-lesson). Uses
 * `.set()` (bulk overwrite) rather than `.create()` so re-running this on
 * every startup never creates duplicates — it just re-declares the same
 * commands. Global commands can take up to ~1 hour to first appear after
 * creation (a normal Discord limitation, not a bug); updates after that
 * are fast.
 */
async function registerSlashCommands(c) {
  await c.application.commands.set([
    {
      name: 'faq',
      description: 'Ρώτα μια συχνή ερώτηση / Ask a frequent question',
      options: [
        {
          name: 'question',
          description: 'Τι θέλεις να ρωτήσεις; / What do you want to ask?',
          type: 3, // STRING
          required: true,
        },
        {
          name: 'language',
          description: 'Γλώσσα απάντησης / Answer language',
          type: 3,
          required: false,
          choices: [
            { name: 'Ελληνικά', value: 'el' },
            { name: 'English', value: 'en' },
          ],
        },
      ],
    },
    {
      name: 'announce-lesson',
      description: 'Ανακοίνωσε ένα νέο course lesson στο Discord',
      // Restricted to members with "Manage Server" — regular subscribers
      // can't use this, only admins/moderators.
      default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
      options: [
        {
          name: 'title',
          description: 'Τίτλος του lesson',
          type: 3, // STRING
          required: true,
        },
        {
          name: 'description',
          description: 'Σύντομη περιγραφή (προαιρετικό)',
          type: 3,
          required: false,
        },
        {
          name: 'link',
          description: 'Link προς το lesson στο Skool (προαιρετικό)',
          type: 3,
          required: false,
        },
      ],
    },
  ]);
  console.log('Registered /faq and /announce-lesson slash commands.');
}
/**
 * Handles the /faq slash command — matches the question against the FAQ
 * keyword list and replies. If FAQ_CHANNEL_ID is set and the command is
 * used elsewhere, gently redirects instead of answering there. Uses slash
 * commands (not raw message reading) specifically so this never requires
 * the privileged Message Content intent.
 */
async function handleFaqCommand(interaction) {
  const faqChannelId = process.env.FAQ_CHANNEL_ID;
  if (faqChannelId && interaction.channelId !== faqChannelId) {
    await interaction.reply({
      content: `Χρησιμοποίησε αυτή την εντολή στο <#${faqChannelId}> 🙂`,
      ephemeral: true,
    });
    return;
  }

  const question = interaction.options.getString('question') || '';
  const lang = interaction.options.getString('language') || 'el';
  const faqs = await loadFaqs();
  const match = findMatch(question, faqs);

  if (match) {
    await interaction.reply({ content: answerForLanguage(match, lang) });
  } else {
    const noMatchMessage = lang === 'en'
      ? "I couldn't find a ready answer for that — ask freely here and we'll help you directly!"
      : 'Δεν βρήκα έτοιμη απάντηση για αυτό — ρώτα ελεύθερα εδώ και θα σε βοηθήσουμε από κοντά!';
    await interaction.reply({
      content: noMatchMessage,
      ephemeral: true,
    });
  }
}
/**
 * Handles the /announce-lesson slash command — posts a formatted
 * announcement to COURSE_ANNOUNCEMENT_CHANNEL_ID. This exists specifically
 * because Skool has no public API/webhooks to detect new lesson uploads
 * automatically, so this is a one-command manual trigger instead of
 * writing the announcement from scratch each time. Command itself is
 * restricted to Manage Server permission (set at registration), so only
 * admins/mods can even see/use it.
 */
async function handleAnnounceLessonCommand(interaction) {
  const channelId = process.env.COURSE_ANNOUNCEMENT_CHANNEL_ID;
  if (!channelId) {
    await interaction.reply({
      content: 'Δεν έχει ρυθμιστεί ακόμα το COURSE_ANNOUNCEMENT_CHANNEL_ID env var — πες στον developer σου να το προσθέσει.',
      ephemeral: true,
    });
    return;
  }

  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const link = interaction.options.getString('link');

  const parts = [`📚 **Νέο lesson: ${title}**`];
  if (description) parts.push(description);
  if (link) parts.push(`👉 ${link}`);

  try {
    const channel = await interaction.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      await interaction.reply({ content: 'Το configured channel δεν είναι text channel.', ephemeral: true });
      return;
    }

    await channel.send(parts.join('\n\n'));
    await interaction.reply({ content: `✅ Ανακοινώθηκε στο <#${channelId}>!`, ephemeral: true });
    console.log(`Announced lesson "${title}" to #${channelId} (by ${interaction.user.username}).`);
  } catch (err) {
    console.error(`Failed to announce lesson to #${channelId}:`, err.message);
    const friendlyMessage =
      err.message === 'Missing Permissions'
        ? `Δεν έχω δικαίωμα να στείλω μήνυμα στο <#${channelId}> — έλεγξε τα channel permissions του bot role εκεί (χρειάζεται "View Channel" + "Send Messages").`
        : `Κάτι πήγε στραβά: ${err.message}`;
    // The interaction may or may not have been replied to yet, depending
    // on where the error happened — try reply first, fall back to
    // followUp if Discord says it's already been acknowledged.
    try {
      await interaction.reply({ content: friendlyMessage, ephemeral: true });
    } catch {
      await interaction.followUp({ content: friendlyMessage, ephemeral: true }).catch(() => {});
    }
  }
}
/**
 * Logs a link to this message if it was posted in the configured
 * WINS_CHANNEL_ID — used to build the monthly wins digest later. Only
 * stores metadata (author, timestamp, message URL), never the message
 * content, since the bot doesn't have the privileged Message Content
 * intent.
 */
async function trackWinsChannelPost(message) {
  const winsChannelId = process.env.WINS_CHANNEL_ID;
  if (!winsChannelId || message.channelId !== winsChannelId) return;

  await logWin({
    date: new Date().toISOString().slice(0, 10),
    author: message.author.username,
    link: message.url,
  });
}
/**
 * Records that this Discord username was active just now, updating their
 * sheet row's "Discord Last Active" column — but only once per
 * ACTIVITY_DEBOUNCE_MS to avoid hammering the Sheets API for chatty users.
 * Safe no-op if the username isn't a subscriber (no matching row).
 */
async function trackActivity(username) {
  const now = Date.now();
  const last = activityDebounce.get(username);
  if (last && now - last < ACTIVITY_DEBOUNCE_MS) return;
  activityDebounce.set(username, now);

  const row = await findRowByDiscordUsername(username);
  if (!row) return; // not a subscriber, nothing to track

  await updateRow(row.rowNumber, { discordLastActive: new Date().toISOString().slice(0, 10) });
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
  try {
    await ensureWinsLogSheet();
  } catch (err) {
    console.error('Could not verify/create the Wins Log tab:', err.message);
  }
  return client;
}
module.exports = { startDiscordGateway };
