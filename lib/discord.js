// lib/discord.js
// Simple wrapper around Discord's REST API — no gateway connection needed,
// we only need to add/remove roles from members.
const DISCORD_API = 'https://discord.com/api/v10';
function headers() {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}
/**
 * Find a guild member by their Discord username (e.g. "storm_56975").
 * Discord's search endpoint matches on username/display name.
 */
async function findMemberByUsername(username) {
  const guildId = process.env.DISCORD_SERVER_ID;
  const url = `${DISCORD_API}/guilds/${guildId}/members/search?query=${encodeURIComponent(
    username
  )}&limit=5`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Discord member search failed: ${res.status} ${await res.text()}`);
  }
  const members = await res.json();
  // Prefer an exact username match, fall back to the first result.
  const exact = members.find(
    (m) => m.user?.username?.toLowerCase() === username.toLowerCase()
  );
  return exact || members[0] || null;
}
/**
 * Give a role to a member. Defaults to the main "winner" role
 * (DISCORD_ROLE_ID) if no roleId is passed — pass DISCORD_VIP_ROLE_ID etc.
 * for other roles like the yearly-subscriber VIP badge.
 */
async function addRoleToUser(discordUserId, roleId = process.env.DISCORD_ROLE_ID) {
  if (!roleId) {
    console.warn('addRoleToUser called with no roleId — skipping.');
    return false;
  }
  const guildId = process.env.DISCORD_SERVER_ID;
  const url = `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;
  const res = await fetch(url, { method: 'PUT', headers: headers() });
  if (!res.ok && res.status !== 204) {
    throw new Error(`Failed to add role: ${res.status} ${await res.text()}`);
  }
  return true;
}
/**
 * Remove a role from a member. Defaults to the main "winner" role.
 */
async function removeRoleFromUser(discordUserId, roleId = process.env.DISCORD_ROLE_ID) {
  if (!roleId) {
    console.warn('removeRoleFromUser called with no roleId — skipping.');
    return false;
  }
  const guildId = process.env.DISCORD_SERVER_ID;
  const url = `${DISCORD_API}/guilds/${guildId}/members/${discordUserId}/roles/${roleId}`;
  const res = await fetch(url, { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 204) {
    // 404 usually means the user already left the server, or didn't have
    // this role — not a fatal error either way.
    if (res.status === 404) return false;
    throw new Error(`Failed to remove role: ${res.status} ${await res.text()}`);
  }
  return true;
}
/**
 * Sends a plain text message to a specific channel via the REST API — no
 * gateway connection needed. Used for admin alerts (new subscription,
 * cancellation, etc) posted to a private admin channel, in addition to the
 * existing email alerts.
 */
async function sendChannelMessage(channelId, content) {
  if (!channelId) {
    console.warn('sendChannelMessage called with no channelId — skipping.');
    return false;
  }
  const url = `${DISCORD_API}/channels/${channelId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`Failed to send channel message: ${res.status} ${await res.text()}`);
  }
  return true;
}

/**
 * Sends a direct message to a member by their Discord user ID. Opens a DM
 * channel first (idempotent — Discord returns the existing channel if one
 * is already open). Returns false (not an error) if the user has DMs from
 * server members disabled/has blocked the bot — that's an expected,
 * non-fatal outcome, not a bug.
 */
async function sendDirectMessage(discordUserId, content) {
  if (!discordUserId) {
    console.warn('sendDirectMessage called with no discordUserId — skipping.');
    return false;
  }

  const dmChannelRes = await fetch(`${DISCORD_API}/users/@me/channels`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!dmChannelRes.ok) {
    throw new Error(`Failed to open DM channel: ${dmChannelRes.status} ${await dmChannelRes.text()}`);
  }
  const dmChannel = await dmChannelRes.json();

  const res = await fetch(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    if (res.status === 403) return false; // DMs closed/bot blocked — not fatal
    throw new Error(`Failed to send DM: ${res.status} ${await res.text()}`);
  }
  return true;
}

/**
 * Creates a Discord native "Scheduled Event" (shows up in the server's
 * Events tab, members can RSVP) — separate from the message-based
 * reminders in jobs/checkEventReminders.js. Uses entity_type EXTERNAL so
 * it doesn't need a specific voice channel; `location` is shown as where
 * the event happens (e.g. a link, or "Discord").
 */
async function createScheduledEvent({ name, description, startTime, endTime, location }) {
  const guildId = process.env.DISCORD_SERVER_ID;
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/scheduled-events`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name,
      description: description || undefined,
      scheduled_start_time: startTime,
      scheduled_end_time: endTime,
      privacy_level: 2, // GUILD_ONLY
      entity_type: 3, // EXTERNAL
      entity_metadata: { location: location || 'Discord' },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create scheduled event: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

module.exports = { findMemberByUsername, addRoleToUser, removeRoleFromUser, sendChannelMessage, sendDirectMessage, createScheduledEvent };
