// lib/nsfwDetection.js
// Wraps the Sightengine nudity detection API (sightengine.com) to flag
// NSFW images posted in the Discord server. Called directly via fetch —
// same "no extra SDK" approach as lib/transcription.js's AssemblyAI
// integration and lib/aiFaq.js's Anthropic integration.
//
// Requires SIGHTENGINE_API_USER + SIGHTENGINE_API_SECRET.
//
// IMPORTANT: seeing image attachments at all requires Discord's
// privileged "Message Content Intent" for the bot (Discord Developer
// Portal → your application → Bot → Privileged Gateway Intents). See
// lib/discordGateway.js — it only requests that intent when these two
// env vars are both set, specifically so the bot still starts up
// normally (all other features unaffected) if this one isn't configured
// yet. But the moment you DO set these two env vars, you must ALSO
// enable Message Content Intent in the Developer Portal at the same
// time — otherwise Discord will refuse the bot's login entirely (every
// Discord feature goes down, not just this one) until you either enable
// the intent or remove these env vars again.

const SIGHTENGINE_API_URL = 'https://api.sightengine.com/1.0/check.json';
const DEFAULT_THRESHOLD = 0.5;

/**
 * Checks one image URL for explicit nudity via Sightengine's nudity-2.1
 * model. Returns { flagged, score, categoryScores }. `score` is the
 * highest of sexual_activity/sexual_display/erotica (Sightengine's
 * "explicit" categories — deliberately not counting the softer
 * suggestive/lingerie/swimwear categories, to avoid flagging things like
 * ordinary beach photos). `flagged` is true when that score exceeds
 * NSFW_THRESHOLD (default 0.5, configurable).
 *
 * Throws on any failure (missing API credentials, network error,
 * Sightengine-side error) so the caller can decide how to degrade — log
 * and skip that image, rather than silently treating a failed check as
 * "safe".
 */
async function checkImageForNsfw(imageUrl) {
  const apiUser = process.env.SIGHTENGINE_API_USER;
  const apiSecret = process.env.SIGHTENGINE_API_SECRET;
  if (!apiUser || !apiSecret) {
    throw new Error('SIGHTENGINE_API_USER/SIGHTENGINE_API_SECRET not configured.');
  }

  const params = new URLSearchParams({
    url: imageUrl,
    models: 'nudity-2.1',
    api_user: apiUser,
    api_secret: apiSecret,
  });

  const res = await fetch(`${SIGHTENGINE_API_URL}?${params.toString()}`);
  const data = await res.json();

  if (data.status !== 'success') {
    const message = data.error ? `${data.error.type}: ${data.error.message}` : `HTTP ${res.status}`;
    throw new Error(`Sightengine API error: ${message}`);
  }

  const nudity = data.nudity || {};
  const explicitScore = Math.max(
    nudity.sexual_activity || 0,
    nudity.sexual_display || 0,
    nudity.erotica || 0
  );
  const threshold = Number(process.env.NSFW_THRESHOLD) || DEFAULT_THRESHOLD;

  return {
    flagged: explicitScore > threshold,
    score: explicitScore,
    categoryScores: {
      sexualActivity: nudity.sexual_activity || 0,
      sexualDisplay: nudity.sexual_display || 0,
      erotica: nudity.erotica || 0,
      suggestive: nudity.suggestive || 0,
      safe: nudity.none || 0,
    },
  };
}

module.exports = { checkImageForNsfw };
