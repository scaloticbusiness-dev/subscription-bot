// lib/referrals.js
// Tracks who referred whom, via Discord invite-link attribution (which
                                                                  // invite code a new member used to join maps to the member who created
                                                                  // that invite). Feeds the refer-a-friend reward: once the referred person
// becomes a paying subscriber, the referrer gets a discount applied to
// their next Stripe invoice (see lib/referralRewards.js).
//
// Same sheet-backed "table" pattern as lib/wins.js / lib/sheets.js — own
// getClient() boilerplate, own tab, ensure-on-startup.

const { google } = require('googleapis');

const REFERRALS_SHEET_NAME = 'Referrals';

let sheetsClient = null;

async function getClient() {
  if (sheetsClient) return sheetsClient;

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
  }

async function ensureReferralsSheet() {
  const sheets = await getClient();
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existing = meta.data.sheets.find((s) => s.properties.title === REFERRALS_SHEET_NAME);
  if (existing) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: REFERRALS_SHEET_NAME } } }] },
    });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${REFERRALS_SHEET_NAME}!A1:F1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [['Joined At', 'Referrer Username', 'Referrer Discord ID', 'Referred Username', 'Referred Discord ID', 'Reward Applied']],
      },
    });

  console.log('Created "Referrals" tab.');
  }

/**
* Records that `referredUsername` joined via an invite created by
* `referrerUsername`. Called once, right when the new member joins —
* before we know whether they'll ever become a paying subscriber.
*/
async function recordReferral({ referrerUsername, referrerDiscordId, referredUsername, referredDiscordId }) {
const sheets = await getClient();
await sheets.spreadsheets.values.append({
spreadsheetId: process.env.GOOGLE_SHEET_ID,
range: `${REFERRALS_SHEET_NAME}!A:F`,
valueInputOption: 'USER_ENTERED',
requestBody: {
values: [[
new Date().toISOString(),
referrerUsername,
referrerDiscordId,
referredUsername,
referredDiscordId,
'',
]],
},
});
}

/**
* Finds the (most recent) unrewarded referral row for a given referred
* Discord username — i.e. "did someone refer this person, and have we
* already paid out the reward for it?". Returns null if this username was
* never referred, or if the reward was already applied.
*/
async function findUnrewardedReferralByReferredUsername(referredUsername) {
const sheets = await getClient();
let res;
try {
res = await sheets.spreadsheets.values.get({
spreadsheetId: process.env.GOOGLE_SHEET_ID,
range: `${REFERRALS_SHEET_NAME}!A2:F`,
});
} catch (err) {
return null; // tab doesn't exist yet — nothing recorded, nothing to find
}

const rows = res.data.values || [];
for (let i = rows.length - 1; i >= 0; i--) {
  const row = rows[i];
  const rowReferred = (row[3] || '').toLowerCase();
  const rewardApplied = row[5] || '';
  if (rowReferred === (referredUsername || '').toLowerCase() && !rewardApplied) {
    return {
      rowNumber: i + 2,
      joinedAt: row[0] || '',
      referrerUsername: row[1] || '',
      referrerDiscordId: row[2] || '',
      referredUsername: row[3] || '',
      referredDiscordId: row[4] || '',
      };
    }
  }
return null;
}

/**
* Marks a referral row's reward as applied (so the same referral never
* pays out twice, e.g. if a subscription is later cancelled and
* re-purchased by the same referred person).
*/
async function markRewardApplied(rowNumber) {
const sheets = await getClient();
await sheets.spreadsheets.values.update({
spreadsheetId: process.env.GOOGLE_SHEET_ID,
range: `${REFERRALS_SHEET_NAME}!F${rowNumber}`,
valueInputOption: 'USER_ENTERED',
requestBody: { values: [[new Date().toISOString().slice(0, 10)]] },
});
}

module.exports = {
ensureReferralsSheet,
recordReferral,
findUnrewardedReferralByReferredUsername,
markRewardApplied,
};
