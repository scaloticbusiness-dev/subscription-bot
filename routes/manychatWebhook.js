// routes/manychatWebhook.js
// POST /manychat-webhook?secret=MANYCHAT_WEBHOOK_SECRET
// Body (JSON): { name, email, phone }
//
// Receives a captured lead from a ManyChat flow (Instagram DM automation)
// via ManyChat's "External Request" action, and appends it to the exact
// same "Αιτήσεις" leads sheet the lotik.gr form writes to — so a lead that
// comes in through an Instagram DM instead of the website form still lands
// in one place and flows through the existing leads pipeline (auto-reply,
// nurture emails, weekly leads report) without anyone copying it in by
// hand.
//
// Uses its own MANYCHAT_WEBHOOK_SECRET rather than ADMIN_API_KEY: this
// endpoint is called by an external no-code tool (not typed by an admin
// in a browser), so it gets a separate, narrower-purpose secret instead of
// reusing the key that also guards the GDPR export/delete endpoints.

const { appendLead } = require('../lib/leads');
const { sendChannelMessage } = require('../lib/discord');

function splitName(fullName) {
const trimmed = (fullName || '').trim();
if (!trimmed) return { firstName: '', lastName: '' };
const parts = trimmed.split(/\s+/);
return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function manychatWebhookHandler(req, res) {
const configuredSecret = process.env.MANYCHAT_WEBHOOK_SECRET;
if (!configuredSecret) {
res.status(500).json({ ok: false, error: 'MANYCHAT_WEBHOOK_SECRET is not configured on the server.' });
return;
}
if (req.query.secret !== configuredSecret) {
res.status(401).json({ ok: false, error: 'Missing or invalid secret.' });
return;
}

const { name, email, phone } = req.body || {};
if (!name && !email && !phone) {
res.status(400).json({ ok: false, error: 'Empty payload — expected at least one of name, email, phone.' });
return;
}

const { firstName, lastName } = splitName(name);

try {
await appendLead({
firstName,
lastName,
email: email || '',
phone: phone || '',
page: 'Instagram DM',
});
console.log(`Recorded Instagram lead via ManyChat: ${name || email || phone}`);

try {
await sendChannelMessage(
process.env.ADMIN_ALERT_CHANNEL_ID,
`🎯 **Νέο lead από Instagram** (μέσω ManyChat)
${name || '(χωρίς όνομα)'}${email ? ` — ${email}` : ''}${phone ? ` — ${phone}` : ''}`
);
} catch (err) {
console.error('Failed to send admin Discord alert for Instagram lead:', err.message);
}

res.json({ ok: true });
} catch (err) {
console.error('Failed to record Instagram lead from ManyChat webhook:', err);
res.status(500).json({ ok: false, error: err.message });
}
}

module.exports = { manychatWebhookHandler };
