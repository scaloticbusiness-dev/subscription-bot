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
module.exports = { findMemberByUsername, addRoleToUser, removeRoleFromUser };
