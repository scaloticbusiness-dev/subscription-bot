// lib/permissionsAudit.js
// Fetches every text channel and role in the Discord server, computes each
// channel's *effective* permissions for @everyone and for any role that
// has an explicit overwrite, and compares them against a small set of
// hand-written rules for the channels where getting this wrong actually
// matters (private/paid channels leaking to everyone, staff channels
// visible to members, etc).
//
// Channels with no rule defined are still included in the snapshot (so
// nothing is invisible in the report), just not flagged pass/fail — add a
// rule to CHANNEL_RULES once you've decided what "correct" means for that
// channel.

const DISCORD_API = 'https://discord.com/api/v10';

function headers() {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Channel and role names in this server include decorative emoji and
// separator characters (e.g. "⭐│results", "🏆│Winners"). Strip everything
// down to plain a-z0-9 before comparing, and always compare with exact
// equality (never substring — "winner-results" would otherwise match the
// "results" rule too).
function normalize(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Discord permission bit flags we care about. Full list:
// https://discord.com/developers/docs/topics/permissions
const PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_GUILD: 1n << 5n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
};

// --- Rules we've explicitly agreed on for specific channels. Channel
// `match` is compared with exact normalized equality against the API
// channel name. Add more entries here as we lock down intended behaviour
// for other channels — anything not listed still shows up in the
// snapshot, just unflagged.
const CHANNEL_RULES = [
  {
    match: 'wins',
    label: '#wins',
    expectEveryone: { view: true, send: false },
    expectRoles: { Winners: { view: true, send: true } },
  },
  {
    match: 'results',
    label: '#results',
    expectEveryone: { view: false, send: false },
    expectRoles: { Winners: { view: true } },
  },
  {
    match: 'winner-results',
    label: '#winner-results',
    expectEveryone: { view: false, send: false },
  },
  {
    match: 'call-schedule',
    label: '#call-schedule',
    expectEveryone: { view: false, send: false },
  },
  {
    match: 'admin-alerts',
    label: '#admin-alerts',
    expectEveryone: { view: false },
  },
  {
    match: 'logs',
    label: '#logs',
    expectEveryone: { view: false },
  },
  {
    match: 'tickets',
    label: '#tickets',
    expectEveryone: { view: false },
  },
];

async function fetchGuildRoles(guildId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Failed to fetch roles: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function fetchGuildChannels(guildId) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, { headers: headers() });
  if (!res.ok) {
    throw new Error(`Failed to fetch channels: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Resolves whether a role can perform `bit` in a channel: starts from the
// role's server-wide base permission, then applies the channel-specific
// overwrite (deny wins over allow, matching Discord's own resolution
// order for a single role).
function resolvePermission(basePermissions, overwrite, bit) {
  let allowed = (BigInt(basePermissions || '0') & bit) === bit;
  if (overwrite) {
    const deny = BigInt(overwrite.deny || '0');
    const allow = BigInt(overwrite.allow || '0');
    if ((deny & bit) === bit) allowed = false;
    else if ((allow & bit) === bit) allowed = true;
  }
  return allowed;
}

async function runPermissionsAudit() {
  const guildId = process.env.DISCORD_SERVER_ID;
  const [roles, channels] = await Promise.all([
    fetchGuildRoles(guildId),
    fetchGuildChannels(guildId),
  ]);

  const roleById = new Map(roles.map((r) => [r.id, r]));
  const everyoneRole = roles.find((r) => r.name === '@everyone');
  // type 0 = GUILD_TEXT, type 5 = GUILD_ANNOUNCEMENT
  const textChannels = channels.filter((c) => c.type === 0 || c.type === 5);

  const issues = [];
  const snapshot = [];

  for (const channel of textChannels) {
    const overwrites = channel.permission_overwrites || [];
    const everyoneOverwrite = overwrites.find((o) => o.id === everyoneRole.id);
    const everyoneView = resolvePermission(everyoneRole.permissions, everyoneOverwrite, PERMISSIONS.VIEW_CHANNEL);
    const everyoneSend = resolvePermission(everyoneRole.permissions, everyoneOverwrite, PERMISSIONS.SEND_MESSAGES);

    const roleOverwrites = overwrites
      .filter((o) => o.type === 0 && o.id !== everyoneRole.id) // type 0 = role overwrite
      .map((o) => {
        const role = roleById.get(o.id);
        return {
          roleName: role ? role.name : `unknown-role-${o.id}`,
          view: resolvePermission(role ? role.permissions : '0', o, PERMISSIONS.VIEW_CHANNEL),
          send: resolvePermission(role ? role.permissions : '0', o, PERMISSIONS.SEND_MESSAGES),
        };
      });

    snapshot.push({
      name: channel.name,
      everyone: { view: everyoneView, send: everyoneSend },
      roles: roleOverwrites,
    });

    const rule = CHANNEL_RULES.find((r) => normalize(channel.name) === normalize(r.match));
    if (!rule) continue;

    if (rule.expectEveryone) {
      if (rule.expectEveryone.view !== undefined && rule.expectEveryone.view !== everyoneView) {
        issues.push(
          `❗ ${rule.label}: @everyone "View Channel" = ${everyoneView} (περιμέναμε ${rule.expectEveryone.view}).`
        );
      }
      if (rule.expectEveryone.send !== undefined && rule.expectEveryone.send !== everyoneSend) {
        issues.push(
          `❗ ${rule.label}: @everyone "Send Messages" = ${everyoneSend} (περιμέναμε ${rule.expectEveryone.send}).`
        );
      }
    }
    if (rule.expectRoles) {
      for (const [roleName, expected] of Object.entries(rule.expectRoles)) {
        const found = roleOverwrites.find((r) => normalize(r.roleName) === normalize(roleName));
        if (!found) {
          issues.push(`❗ ${rule.label}: δεν βρέθηκε overwrite για τον ρόλο "${roleName}".`);
          continue;
        }
        if (expected.view !== undefined && expected.view !== found.view) {
          issues.push(
            `❗ ${rule.label}: ρόλος "${roleName}" "View Channel" = ${found.view} (περιμέναμε ${expected.view}).`
          );
        }
        if (expected.send !== undefined && expected.send !== found.send) {
          issues.push(
            `❗ ${rule.label}: ρόλος "${roleName}" "Send Messages" = ${found.send} (περιμέναμε ${expected.send}).`
          );
        }
      }
    }
  }

  // Server-wide risk check: does @everyone have any dangerous permission
  // at the base role level? This affects the WHOLE server, not one channel.
  const dangerousKeys = [
    'ADMINISTRATOR',
    'MANAGE_GUILD',
    'MANAGE_ROLES',
    'MANAGE_CHANNELS',
    'KICK_MEMBERS',
    'BAN_MEMBERS',
  ];
  for (const key of dangerousKeys) {
    const bit = PERMISSIONS[key];
    if ((BigInt(everyoneRole.permissions || '0') & bit) === bit) {
      issues.push(`🚨 ΣΟΒΑΡΟ: ο ρόλος @everyone έχει server-wide δικαίωμα "${key}" — το έχει ΟΛΟΣ ο κόσμος.`);
    }
  }

  return { issues, snapshot };
}

module.exports = { runPermissionsAudit, CHANNEL_RULES };
