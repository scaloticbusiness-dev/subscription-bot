// routes/stripeWebhook.js
// Receives events from Stripe. On a successful checkout, it:
//   1. Works out the plan (Monthly/Yearly) from the Stripe Price interval
//   2. Calculates the renewal date
//   3. Writes/updates the row in Google Sheets
//   4. Gives the Discord role to the customer
//   5. Sends the customer a welcome email with the Discord invite link
//   6. Reminds the admin to manually send the Skool invite (no Skool API)
// On an immediate cancellation, it removes the Discord role and marks the
// sheet row as "Expired" right away, instead of waiting for the next day's
// scheduled check.

const Stripe = require('stripe');
const { findMemberByUsername, addRoleToUser, removeRoleFromUser } = require('../lib/discord');
const { findRowByEmail, appendRow, updateRow } = require('../lib/sheets');
const { calculateRenewalDate } = require('../lib/renewal');
const { sendWelcomeEmail, sendSkoolInviteReminder, sendSkoolRemovalAlert } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Pulls the "Discord Username" custom field out of a Checkout Session.
 * Matches the custom field key already configured on the existing
 * Stripe Payment Links: "discordusername" (no underscore).
 */
function extractDiscordUsername(session) {
  const field = (session.custom_fields || []).find(
    (f) => f.key === 'discordusername'
  );
  return field?.text?.value?.trim() || null;
}

async function getPlanIntervalLabel(session) {
  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
    expand: ['data.price.product'],
  });

  const price = lineItems.data[0]?.price;
  const interval = price?.recurring?.interval; // 'month' | 'year'
  const productName = price?.product?.name || 'Subscription';

  const planLabel =
    interval === 'year' ? `${productName} - Yearly` : `${productName} - Monthly`;

  return { planLabel, interval };
}

async function handleCheckoutCompleted(session) {
  const email = session.customer_details?.email || session.customer_email;
  const discordUsername = extractDiscordUsername(session);
  const amount = session.amount_total ? (session.amount_total / 100).toFixed(2) : '';

  if (!email) {
    console.error('Checkout session has no email, skipping:', session.id);
    return;
  }
  if (!discordUsername) {
    console.error(
      `Checkout session ${session.id} has no discord_username custom field — cannot assign role.`
    );
  }

  const { planLabel } = await getPlanIntervalLabel(session);
  const today = new Date().toISOString().slice(0, 10);
  const renewalDate = calculateRenewalDate(today, planLabel);

  // Find the Discord member (to store their user ID, and to add the role)
  let discordUserId = null;
  if (discordUsername) {
    try {
      const member = await findMemberByUsername(discordUsername);
      discordUserId = member?.user?.id || null;
      if (discordUserId) {
        await addRoleToUser(discordUserId);
        console.log(`Role added to ${discordUsername} (${discordUserId})`);
      } else {
        console.error(`Could not find Discord member for username: ${discordUsername}`);
      }
    } catch (err) {
      console.error('Discord role assignment failed:', err.message);
    }
  }

  // Write to Google Sheets — update existing row if this email already exists,
  // otherwise append a brand new row.
  const existing = await findRowByEmail(email);
  const rowData = {
    name: session.customer_details?.name || existing?.name || '',
    email,
    discordUsername: discordUsername || existing?.discordUsername || '',
    date: today,
    renewalDate,
    status: 'Active',
    plan: planLabel,
    amount: amount || existing?.amount || '',
  };

  if (existing) {
    await updateRow(existing.rowNumber, rowData);
    console.log(`Updated sheet row ${existing.rowNumber} for ${email}`);
  } else {
    await appendRow({ ...rowData, discordJoined: 'No', skoolInvited: 'No' });
    console.log(`Added new sheet row for ${email}`);
  }

  // Send the welcome email with the Discord invite link. This never throws
  // out of the main flow — a failed/misconfigured email should not stop the
  // role assignment or sheet update above.
  try {
    await sendWelcomeEmail(email);
  } catch (err) {
    console.error('Failed to send welcome email:', err.message);
  }

  // Remind the admin to manually send this person their Skool invite —
  // Skool has no public API, so this step can't be automated.
  try {
    await sendSkoolInviteReminder({
      name: rowData.name,
      email,
      plan: planLabel,
    });
  } catch (err) {
    console.error('Failed to send Skool invite reminder:', err.message);
  }
}

/**
 * Handles an immediate subscription cancellation (as opposed to a natural
 * expiration caught by the daily job). Removes the Discord role and marks
 * the sheet row "Expired" right away, so the sheet reflects reality without
 * waiting for tomorrow's scheduled check — and the row turns red immediately
 * via the existing conditional formatting on the Status column.
 */
async function handleSubscriptionDeleted(subscription) {
  const customerId = subscription.customer;
  if (!customerId) {
    console.error('Subscription deleted event has no customer id, skipping.');
    return;
  }

  const customer = await stripe.customers.retrieve(customerId);
  const email = customer?.email;
  if (!email) {
    console.error(`Could not find an email for customer ${customerId}, skipping.`);
    return;
  }

  const row = await findRowByEmail(email);
  if (!row) {
    console.warn(`No sheet row found for cancelled customer ${email}.`);
    return;
  }

  if (row.status.toLowerCase() !== 'active') {
    console.log(`Row for ${email} is already ${row.status}, nothing to do.`);
    return;
  }

  try {
    if (row.discordUsername) {
      const member = await findMemberByUsername(row.discordUsername);
      if (member?.user?.id) {
        await removeRoleFromUser(member.user.id);
        console.log(`Removed role from ${row.discordUsername} (immediate cancellation)`);
      }
    }
  } catch (err) {
    console.error('Discord role removal failed on cancellation:', err.message);
  }

  await updateRow(row.rowNumber, { status: 'Expired' });
  console.log(`Marked row ${row.rowNumber} (${email}) as Expired (immediate cancellation)`);

  try {
    await sendSkoolRemovalAlert([{ name: row.name, email, plan: row.plan }]);
  } catch (err) {
    console.error('Failed to send Skool removal alert on cancellation:', err.message);
  }
}

/**
 * Express route handler. Must be mounted with express.raw({type: 'application/json'})
 * so the raw body is available for Stripe signature verification.
 */
async function stripeWebhookHandler(req, res) {
  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    }
    // Other event types can be handled here later if needed.

    res.json({ received: true });
  } catch (err) {
    console.error('Error handling webhook event:', err);
    // Respond 200 anyway so Stripe doesn't endlessly retry a broken handler —
    // the error is logged for us to fix.
    res.status(200).json({ received: true, error: err.message });
  }
}

module.exports = { stripeWebhookHandler };
