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
const { findRowByDiscordUsername, updateRow, getAllRows } = require('./sheets');
const { isExpired } = require('../jobs/checkExpiredSubscriptions');
const { addRoleToUser, sendDirectMessage, sendChannelMessage } = require('./discord');
const { loadFaqs, findMatch, answerForLanguage } = require('./faq');
const { generateAiFaqAnswer } = require('./aiFaq');
const { ensureWinsLogSheet, logWin } = require('./wins');
const { transcribeUrl } = require('./transcription');
const { ensureTranscriptsSheet, saveTranscript, searchTranscripts } = require('./transcripts');
const { sendReplayEmail } = require('./email');
const { ensureAttendanceLogSheet, logAttendance, getAttendeesInWindow } = require('./attendance');
const { getAllEvents } = require('./events');
const { ensureReferralsSheet, recordReferral } = require('./referrals');
const { migrateToYearly } = require('./planMigration');
const { ensureSupportTicketsSheet, addTicket, findTicketByChannelId, updateTicketRow } = require('./supportTickets');
const { checkImageForNsfw } = require('./nsfwDetection');

// Brand gold, matching the Winners/wins trophy theme used elsewhere.
const BRAND_COLOR = 0xc99a3b;

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

/**
 * A small personalized embed (avatar thumbnail + member number) that goes
 * alongside the plain-text welcome message — a lighter-weight stand-in for
 * a rendered "welcome card" image, without adding an image-generation
 * dependency (canvas/sharp) to the bot.
 */
function buildWelcomeEmbed(member) {
    return {
          color: BRAND_COLOR,
          author: {
                  name: member.user.username,
                  icon_url: member.user.displayAvatarURL({ size: 64 }),
          },
          description: 'Καλωσόρισες στο lotik! 🎉',
          thumbnail: { url: member.user.displayAvatarURL({ size: 128 }) },
          footer: { text: `Μέλος #${member.guild.memberCount}` },
          timestamp: new Date().toISOString(),
    };
}

/**
 * Short 3-step DM sent alongside the channel welcome message. Best-effort —
 * plenty of members have DMs from server members disabled, which is a
 * normal, non-fatal outcome (sendDirectMessage returns false, not an
 * error, in that case).
 */
function buildWelcomeDM(member) {
    return `👋 Γεια σου ${member.user.username}, καλωσόρισες στο lotik!

    Τρία γρήγορα βήματα για να ξεκινήσεις:
    1️⃣ Δες τους κανόνες στο #rules
    2️⃣ Πες ένα «γεια» στο #general — πες μας ποιος είσαι και τι θέλεις να πετύχεις
    3️⃣ Ερώτηση; Το #faq απαντάει άμεσα με /faq [ερώτησή σου]

    Χαιρόμαστε πολύ που είσαι εδώ! 🎉`;
}

// In-memory debounce for activity tracking: only write to the sheet once
// per hour per username, even if someone is chatting constantly. Resets on
// every deploy/restart, which just means the next message after a restart
// writes once more than strictly necessary — harmless.
const activityDebounce = new Map();
const ACTIVITY_DEBOUNCE_MS = 60 * 60 * 1000; // 1 hour

// In-memory cache of invite code -> use count, used to work out which
// invite a new member used (Discord doesn't tell you directly — you diff
// the "uses" count against what it was right before they joined). Reset on
// every deploy/restart; refetched fresh on `ready`, so a restart only
// costs one comparison's worth of accuracy, not ongoing tracking.
const inviteUsesCache = new Map();

let client = null;
function buildClient() {
    // Message Content is a privileged Discord intent — only request it
    // when NSFW image detection is actually configured (see
    // lib/nsfwDetection.js), so the bot still logs in fine everywhere
    // else if the Developer Portal toggle for it hasn't been flipped yet.
    // Discord attachments are stripped from the gateway payload without
    // this intent, which is why it's needed at all.
    const nsfwDetectionConfigured = Boolean(process.env.SIGHTENGINE_API_USER && process.env.SIGHTENGINE_API_SECRET);
    const intents = [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.GuildVoiceStates,
          GatewayIntentBits.GuildInvites,
        ];
    if (nsfwDetectionConfigured) intents.push(GatewayIntentBits.MessageContent);

  const c = new Client({
          intents,
          partials: [Partials.GuildMember],
    });
    c.once('ready', async () => {
          console.log(`Discord gateway connected as ${c.user.tag}`);
          try {
                  await registerSlashCommands(c);
          } catch (err) {
                  console.error('Failed to register slash commands:', err.message);
          }
          try {
                  await primeInviteCache(c);
          } catch (err) {
                  console.error('Failed to prime invite cache (referral tracking may not work until next restart):', err.message);
          }
    });
    c.on('inviteCreate', (invite) => {
          inviteUsesCache.set(invite.code, invite.uses || 0);
    });
    c.on('inviteDelete', (invite) => {
          inviteUsesCache.delete(invite.code);
    });
    c.on('guildMemberAdd', async (member) => {
          try {
                  await sendWelcomeMessage(member);
          } catch (err) {
                  console.error('Failed to send welcome message:', err.message);
          }
          try {
                  await sendWelcomeDM(member);
          } catch (err) {
                  console.error('Failed to send welcome DM:', err.message);
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
          try {
                  await trackReferralOnJoin(member);
          } catch (err) {
                  console.error('Failed to track referral on join:', err.message);
          }
    });
    c.on('channelCreate', async (channel) => {
          try {
                  if (!process.env.TICKET_CATEGORY_ID) return;
                  if (channel.parentId !== process.env.TICKET_CATEGORY_ID) return;
                  await addTicket({ channelId: channel.id, channelName: channel.name, openedAt: new Date().toISOString() });
                  console.log(`Tracking new support ticket: #${channel.name}`);
          } catch (err) {
                  console.error('Failed to track new ticket channel:', err.message);
          }
    });
    c.on('channelDelete', async (channel) => {
          try {
                  if (!process.env.TICKET_CATEGORY_ID) return;
                  if (channel.parentId !== process.env.TICKET_CATEGORY_ID) return;
                  const ticket = await findTicketByChannelId(channel.id);
                  if (!ticket || ticket.closedAt) return;
                  await updateTicketRow(ticket.rowNumber, { closedAt: new Date().toISOString() });
                  console.log(`Marked support ticket #${channel.name} as closed.`);
          } catch (err) {
                  console.error('Failed to mark ticket channel closed:', err.message);
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
          try {
                  if (message.author.bot) return;
                  if (!process.env.TICKET_CATEGORY_ID || !process.env.TICKET_SUPPORT_ROLE_ID) return;
                  if (message.channel?.parentId !== process.env.TICKET_CATEGORY_ID) return;
                  if (!message.member?.roles?.cache?.has(process.env.TICKET_SUPPORT_ROLE_ID)) return;
                  const ticket = await findTicketByChannelId(message.channelId);
                  if (!ticket || ticket.firstResponseAt) return;
                  await updateTicketRow(ticket.rowNumber, { firstResponseAt: new Date().toISOString() });
                  console.log(`Recorded first support response for ticket #${message.channel.name}.`);
          } catch (err) {
                  console.error('Failed to record ticket first response:', err.message);
          }
          try {
                  if (message.author.bot) return;
                  if (!process.env.SIGHTENGINE_API_USER || !process.env.SIGHTENGINE_API_SECRET) return;
                  const imageAttachments = message.attachments.filter((a) => (a.contentType || '').startsWith('image/'));
                  if (imageAttachments.size === 0) return;

                  for (const attachment of imageAttachments.values()) {
                          try {
                                  const result = await checkImageForNsfw(attachment.url);
                                  if (!result.flagged) continue;

                                  await message.delete().catch((err) => console.error('Failed to delete flagged image message:', err.message));
                                  await sendDirectMessage(
                                          message.author.id,
                                          'Η εικόνα που ανέβασες στο Discord server αφαιρέθηκε επειδή εντοπίστηκε ως πιθανώς ακατάλληλη (NSFW). Αν νομίζεις ότι έγινε λάθος, επικοινώνησε με την ομάδα.'
                                  ).catch(() => {});
                                  if (process.env.ADMIN_ALERT_CHANNEL_ID) {
                                          await sendChannelMessage(
                                                  process.env.ADMIN_ALERT_CHANNEL_ID,
                                                  `🚨 Αφαιρέθηκε πιθανώς ακατάλληλη εικόνα από τον/την ${message.author.username} στο <#${message.channelId}> (score: ${result.score.toFixed(2)}).`
                                          ).catch(() => {});
                                  }
                                  console.log(`Deleted flagged NSFW image from ${message.author.username} (score ${result.score.toFixed(2)}).`);
                          } catch (err) {
                                  console.error(`Failed to check image for NSFW (${attachment.url}):`, err.message);
                          }
                  }
          } catch (err) {
                  console.error('Failed to run NSFW image check:', err.message);
          }
    });
    c.on('interactionCreate', async (interaction) => {
          try {
                  if (!interaction.isChatInputCommand()) return;
                  if (interaction.commandName === 'faq') {
                            await handleFaqCommand(interaction);
                  } else if (interaction.commandName === 'announce-lesson') {
                            await handleAnnounceLessonCommand(interaction);
                  } else if (interaction.commandName === 'transcribe') {
                            await handleTranscribeCommand(interaction);
                  } else if (interaction.commandName === 'search-transcripts') {
                            await handleSearchTranscriptsCommand(interaction);
                  } else if (interaction.commandName === 'poll') {
                            await handlePollCommand(interaction);
                  } else if (interaction.commandName === 'send-replay') {
                            await handleSendReplayCommand(interaction);
                  } else if (interaction.commandName === 'migrate-to-yearly') {
                            await handleMigrateToYearlyCommand(interaction);
                  }
          } catch (err) {
                  console.error(`Failed to handle /${interaction.commandName} command:`, err.message);
          }
    });
    c.on('voiceStateUpdate', async (oldState, newState) => {
          try {
                  if (!newState.channelId) return; // they left, not joined
            if (oldState.channelId === newState.channelId) return; // no actual channel change
            if (newState.member?.user?.bot) return;
                  await trackVoiceAttendance(newState.member.user.username);
          } catch (err) {
                  console.error('Failed to track voice attendance:', err.message);
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
    await channel.send({ content: text, embeds: [buildWelcomeEmbed(member)] });
    console.log(`Sent welcome message to ${member.user.username}`);
}

/**
 * DMs the new member a short 3-step getting-started message, separate from
 * (and in addition to) the channel welcome message above — some members
 * miss the channel post entirely if it scrolls past quickly.
 */
async function sendWelcomeDM(member) {
    const sent = await sendDirectMessage(member.id, buildWelcomeDM(member));
    if (sent) {
          console.log(`Sent welcome DM to ${member.user.username}`);
    } else {
          console.log(`Could not DM ${member.user.username} (DMs closed/bot blocked) — channel welcome message still sent.`);
    }
}

/**
 * Fetches the guild's current invites and seeds `inviteUsesCache` with
 * their use counts. Called once on `ready`, before any `guildMemberAdd`
 * events can be diffed against it. Requires the bot's role to have "Manage
 * Server" — logs a clear warning (once, at startup) and leaves referral
 * tracking silently disabled if it doesn't, rather than crashing.
 */
async function primeInviteCache(c) {
    const guildId = process.env.DISCORD_SERVER_ID;
    const guild = await c.guilds.fetch(guildId);
    const invites = await guild.invites.fetch();
    inviteUsesCache.clear();
    invites.forEach((invite) => inviteUsesCache.set(invite.code, invite.uses || 0));
    console.log(`Primed invite cache with ${invites.size} invite(s) for referral tracking.`);
}

/**
 * Works out which invite a newly-joined member used (by diffing current
 * invite use counts against the cached ones) and, if that invite's creator
 * is a different existing member, records a referral. This is
 * best-effort: a member joining via the server's vanity URL, a since-
 * deleted invite, or when the bot lacks "Manage Server" (can't read
 * invites at all) simply won't be attributed — logged, never thrown.
 */
async function trackReferralOnJoin(member) {
    let invites;
    try {
          invites = await member.guild.invites.fetch();
    } catch (err) {
          console.warn(
                  'Could not fetch invites (bot role may need "Manage Server" permission) — skipping referral attribution:',
                  err.message
                );
          return;
    }

  const usedInvite = invites.find((invite) => (invite.uses || 0) > (inviteUsesCache.get(invite.code) || 0));

  // Refresh the cache regardless of whether we found a match, so the next
  // join is compared against current counts.
  inviteUsesCache.clear();
    invites.forEach((invite) => inviteUsesCache.set(invite.code, invite.uses || 0));

  if (!usedInvite || !usedInvite.inviter) return; // vanity URL, or ambiguous — can't attribute
  if (usedInvite.inviter.id === member.id) return; // can't refer yourself

  await recordReferral({
        referrerUsername: usedInvite.inviter.username,
        referrerDiscordId: usedInvite.inviter.id,
        referredUsername: member.user.username,
        referredDiscordId: member.id,
  });
    console.log(`Recorded referral: ${usedInvite.inviter.username} -> ${member.user.username}`);
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
      {
              name: 'transcribe',
              description: 'Μετέτρεψε ένα βίντεο/ήχο σε κείμενο (speech-to-text)',
              // Restricted to Manage Server — this costs money per use.
              default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
              options: [
                {
                            name: 'link',
                            description: 'Direct link προς το αρχείο (video/audio) — ΟΧΙ YouTube watch page',
                            type: 3,
                            required: true,
                },
                {
                            name: 'title',
                            description: 'Τίτλος για αναφορά στο sheet (προαιρετικό)',
                            type: 3,
                            required: false,
                },
                      ],
      },
      {
              name: 'search-transcripts',
              description: 'Ψάξε στα απομαγνητοφωνημένα μαθήματα για μια λέξη ή φράση',
              options: [
                { name: 'query', description: 'Τι θέλεις να ψάξεις;', type: 3, required: true },
                      ],
      },
      {
              name: 'poll',
              description: 'Δημιούργησε ένα ψήφισμα (π.χ. για το επόμενο θέμα live Q&A)',
              default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
              options: [
                { name: 'question', description: 'Η ερώτηση του ψηφίσματος', type: 3, required: true },
                { name: 'option1', description: 'Επιλογή 1', type: 3, required: true },
                { name: 'option2', description: 'Επιλογή 2', type: 3, required: true },
                { name: 'option3', description: 'Επιλογή 3 (προαιρετικό)', type: 3, required: false },
                { name: 'option4', description: 'Επιλογή 4 (προαιρετικό)', type: 3, required: false },
                      ],
      },
      {
              name: 'send-replay',
              description: 'Στείλε το replay ενός event σε όσους δεν παρευρέθηκαν',
              default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
              options: [
                { name: 'event', description: 'Ακριβές όνομα του event (όπως στο Events tab)', type: 3, required: true },
                { name: 'link', description: 'Link προς το replay', type: 3, required: true },
                      ],
      },
      {
              name: 'migrate-to-yearly',
              description: 'Μετέτρεψε έναν συνδρομητή από μηνιαίο σε ετήσιο πλάνο (με proration στο Stripe)',
              default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
              options: [
                { name: 'member', description: 'Ο συνδρομητής προς μετατροπή', type: 6, required: true },
                      ],
      },
        ]);
    console.log('Registered /faq, /announce-lesson, /transcribe, /search-transcripts, /poll, /send-replay, and /migrate-to-yearly slash commands.');
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
        return;
  }

  const noMatchMessage = lang === 'en'
        ? "I couldn't find a ready answer for that — ask freely here and we'll help you directly!"
        : 'Δεν βρήκα έτοιμη απάντηση για αυτό — ρώτα ελεύθερα εδώ και θα σε βοηθήσουμε από κοντά!';

  // No keyword match — fall back to the AI FAQ bot (grounded in the same
  // FAQ sheet rows), if ANTHROPIC_API_KEY is configured. Needs a
  // deferReply since generating an answer takes longer than Discord's
  // 3-second initial-response window.
  if (!process.env.ANTHROPIC_API_KEY) {
        await interaction.reply({ content: noMatchMessage, ephemeral: true });
        return;
  }

  await interaction.deferReply();
    try {
          const answer = await generateAiFaqAnswer({ question, lang, faqs });
          await interaction.editReply({ content: answer });
          console.log(`Answered /faq via AI fallback: "${question}"`);
    } catch (err) {
          console.error('AI FAQ fallback failed:', err.message);
          await interaction.editReply({ content: noMatchMessage });
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
 * Handles the /transcribe slash command — submits the given direct media
 * URL to AssemblyAI, waits for the result (can take a couple of minutes
 * for longer videos), and saves it to the "Transcripts" sheet tab.
 * Immediately defers the reply since transcription takes much longer than
 * Discord's 3-second interaction response window; Discord follow-up edits
 * stay valid for 15 minutes, which comfortably covers most videos.
 */
async function handleTranscribeCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });

  const link = interaction.options.getString('link');
    const title = interaction.options.getString('title') || '';

  try {
        const { text, durationSeconds } = await transcribeUrl(link);
        await ensureTranscriptsSheet();
        await saveTranscript({ title, sourceLink: link, durationSeconds, text });

      const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
        const durationLabel = durationSeconds ? `${(durationSeconds / 60).toFixed(1)} λεπτά` : 'άγνωστη διάρκεια';
        await interaction.editReply({
                content: `✅ Έτοιμο! (${durationLabel}) Αποθηκεύτηκε στο tab "Transcripts" του Google Sheet.\n\n**Προεπισκόπηση:**\n${preview}`,
        });
        console.log(`Transcribed "${title || link}" (${durationLabel}).`);
  } catch (err) {
        console.error(`Failed to transcribe ${link}:`, err.message);
        await interaction.editReply({
                content: `❌ Κάτι πήγε στραβά: ${err.message}\n\nΥπενθύμιση: το link πρέπει να είναι απευθείας πρόσβαση στο αρχείο (π.χ. Google Drive direct-download link), όχι σελίδα προβολής/YouTube link.`,
        });
  }
}
/**
 * Handles /search-transcripts — searches every saved transcript (see
 * lib/transcripts.js) for the given query and replies with the top
 * matches (title, duration, source link, and a short snippet showing
 * where the term came up). Open to everyone, not just admins, since it's
 * a read-only lookup with no cost per use — unlike /transcribe.
 */
async function handleSearchTranscriptsCommand(interaction) {
  const query = interaction.options.getString('query') || '';

  try {
        const results = await searchTranscripts(query);
        if (results.length === 0) {
                await interaction.reply({
                        content: `Δεν βρήκα κανένα μάθημα που να αναφέρει "${query}" — δοκίμασε άλλη λέξη-κλειδί ή ρώτα ελεύθερα εδώ.`,
                        ephemeral: true,
                });
                return;
        }

      const blocks = results.map((r) => {
              const durationLabel = r.durationMin ? ` (${r.durationMin} λεπτά)` : '';
              const linkLine = r.sourceLink ? `\n🔗 ${r.sourceLink}` : '';
              return `**${r.title}**${durationLabel}\n${r.snippet}${linkLine}`;
      });

      await interaction.reply({
              content: `🔍 Βρήκα ${results.length} αποτέλεσμα${results.length === 1 ? '' : 'τα'} για "${query}":\n\n${blocks.join('\n\n')}`,
      });
        console.log(`Answered /search-transcripts for "${query}" (${results.length} result(s)).`);
  } catch (err) {
        console.error(`Failed to search transcripts for "${query}":`, err.message);
        await interaction.reply({ content: `❌ Κάτι πήγε στραβά: ${err.message}`, ephemeral: true });
  }
}
// Debounce for voice attendance: only log once per 30 minutes per
// username, even if they hop between channels repeatedly during one event.
const voiceAttendanceDebounce = new Map();
const VOICE_ATTENDANCE_DEBOUNCE_MS = 30 * 60 * 1000;

async function trackVoiceAttendance(username) {
    const now = Date.now();
    const last = voiceAttendanceDebounce.get(username);
    if (last && now - last < VOICE_ATTENDANCE_DEBOUNCE_MS) return;
    voiceAttendanceDebounce.set(username, now);

  await logAttendance(username);
}
/**
 * Handles /poll — posts a message with the question + up to 4 options,
 * and adds number-emoji reactions so members can vote by reacting.
 */
async function handlePollCommand(interaction) {
    const question = interaction.options.getString('question');
    const options = [
          interaction.options.getString('option1'),
          interaction.options.getString('option2'),
          interaction.options.getString('option3'),
          interaction.options.getString('option4'),
        ].filter(Boolean);

  const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    const optionLines = options.map((opt, i) => `${numberEmojis[i]} ${opt}`).join('\n');

  await interaction.reply(`📊 **${question}**\n\n${optionLines}\n\nΨήφισε κάνοντας react παρακάτω!`);
    const message = await interaction.fetchReply();
    for (let i = 0; i < options.length; i++) {
          await message.react(numberEmojis[i]);
    }
    console.log(`Posted poll "${question}" (by ${interaction.user.username}).`);
}
/**
 * Handles /send-replay — finds who attended the named event (via the
 * Attendance Log, matched against that event's time window) and emails
 * the replay link only to Active subscribers who did NOT attend.
 */
async function handleSendReplayCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });

  const eventName = interaction.options.getString('event');
    const link = interaction.options.getString('link');

  try {
        const events = await getAllEvents();
        const event = events.find((e) => e.name.toLowerCase() === eventName.toLowerCase());
        if (!event) {
                await interaction.editReply({ content: `Δεν βρήκα event με όνομα "${eventName}" στο Events tab.` });
                return;
        }

      const startTime = new Date(event.dateTime);
        const endTime = new Date(startTime.getTime() + 90 * 60 * 1000);
        const attendeeUsernames = await getAttendeesInWindow(startTime.toISOString(), endTime.toISOString());

      const rows = await getAllRows();
        const nonAttendees = rows.filter(
                (r) =>
                          r.status.toLowerCase() === 'active' &&
                          r.discordUsername &&
                          !attendeeUsernames.has(r.discordUsername) &&
                          r.email
              );

      let sentCount = 0;
        for (const row of nonAttendees) {
                try {
                          await sendReplayEmail({ name: row.name, email: row.email, eventName: event.name, link });
                          sentCount += 1;
                } catch (err) {
                          console.error(`Failed to send replay email to ${row.email}:`, err.message);
                }
        }

      await interaction.editReply({
              content: `✅ Στάλθηκε το replay σε ${sentCount} άτομα που δεν παρευρέθηκαν στο "${event.name}" (${attendeeUsernames.size} παρευρέθηκαν).`,
      });
        console.log(`Sent replay for "${event.name}" to ${sentCount} non-attendee(s).`);
  } catch (err) {
        console.error('Failed to process /send-replay:', err.message);
        await interaction.editReply({ content: `❌ Κάτι πήγε στραβά: ${err.message}` });
  }
}
/**
 * Handles the /migrate-to-yearly slash command — switches the target
 * member's active Stripe subscription to the yearly Price (prorating the
 * switch) and updates their sheet row, then grants the VIP role to match
 * the existing convention for yearly subscribers.
 */
async function handleMigrateToYearlyCommand(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const member = interaction.options.getUser('member');

  try {
    const result = await migrateToYearly(member.username);
    if (!result.ok) {
      await interaction.editReply({ content: `❌ ${result.reason}` });
      return;
    }

    if (process.env.DISCORD_VIP_ROLE_ID) {
      try {
        await addRoleToUser(member.id, process.env.DISCORD_VIP_ROLE_ID);
      } catch (err) {
        console.error(`Failed to grant VIP role to ${member.username} after migration:`, err.message);
      }
    }

    await interaction.editReply({
      content: `✅ Ο/Η ${member.username} μετατράπηκε σε ετήσιο πλάνο (${result.planLabel}). Νέα ανανέωση: ${result.renewalDate} (${result.amount}€). Το Stripe θα χρεώσει τη διαφορά proration στο επόμενο invoice.`,
    });
    console.log(`Processed /migrate-to-yearly for ${member.username}.`);
  } catch (err) {
    console.error(`Failed to process /migrate-to-yearly for ${member.username}:`, err.message);
    await interaction.editReply({ content: `❌ Κάτι πήγε στραβά: ${err.message}` });
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
    try {
          await ensureAttendanceLogSheet();
    } catch (err) {
          console.error('Could not verify/create the Attendance Log tab:', err.message);
    }
    try {
          await ensureReferralsSheet();
    } catch (err) {
          console.error('Could not verify/create the Referrals tab:', err.message);
    }
    try {
          await ensureSupportTicketsSheet();
    } catch (err) {
          console.error('Could not verify/create the Support Tickets tab:', err.message);
    }
    return client;
}
module.exports = { startDiscordGateway };
