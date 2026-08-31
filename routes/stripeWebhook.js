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
const { findMemberByUsername, addRoleToUser, removeRoleFromUser, sendChannelMessage } = require('../lib/discord');
const { findRowByEmail, findRowByDiscordUsername, appendRow, updateRow } = require('../lib/sheets');
const { calculateRenewalDate } = require('../lib/renewal');
const { sendWelcomeEmail, sendSkoolInviteReminder, sendSkoolRemovalAlert, sendPaymentFailedEmail, sendGoodbyeEmail, sendDuplicateSignupAlert, sendRapidCycleAlert, sendAbandonedCheckoutEmail, sendChargebackDraftAlert, sendSaveOfferEmail } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function daysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr);
  if (isNaN(start.getTime())) return null;
  start.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
}

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

/**
 * Pulls the "ToS acceptance" custom field out of a Checkout Session — a
 * single-option required dropdown (Stripe has no true checkbox custom
 * field type), so any non-empty answer means the customer selected it.
 * TOS_VERSION records which version of the terms was live at signup time.
 */
function extractTosAcceptance(session) {
  const field = (session.custom_fields || []).find(
    (f) => f.key === 'tos_acceptance'
  );
  const accepted = field?.dropdown?.value ? 'Yes' : '';
  return { accepted, version: accepted ? (process.env.TOS_VERSION || 'v1') : '' };
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

  // Check for signs of a duplicate/suspicious signup before doing anything
  // else. This never blocks the actual role/sheet/email flow below — it
  // just alerts the admin so they can take a look.
  try {
    const duplicateIssues = [];

    const existingByEmail = await findRowByEmail(email);
    if (existingByEmail && existingByEmail.status.toLowerCase() === 'active') {
      duplicateIssues.push(
        `❗ Αυτό το email έχει ήδη μια Active συνδρομή στο sheet (γραμμή ${existingByEmail.rowNumber}) — νέα πληρωμή μπορεί να είναι διπλή χρέωση.`
      );
    }

    if (discordUsername) {
      const existingByUsername = await findRowByDiscordUsername(discordUsername);
      if (
        existingByUsername &&
        existingByUsername.email.toLowerCase() !== email.toLowerCase() &&
        existingByUsername.status.toLowerCase() === 'active'
      ) {
        duplicateIssues.push(
          `❗ Το Discord username "${discordUsername}" είναι ήδη συνδεδεμένο με άλλο ενεργό email (${existingByUsername.email}, γραμμή ${existingByUsername.rowNumber}).`
        );
      }
    }

    if (duplicateIssues.length > 0) {
      await sendDuplicateSignupAlert({
        issues: duplicateIssues,
        name: session.customer_details?.name || '',
        email,
        discordUsername,
      });

      try {
        await sendChannelMessage(
          process.env.ADMIN_ALERT_CHANNEL_ID,
          `⚠️ **Πιθανή διπλή εγγραφή**\n${session.customer_details?.name || email}\n${duplicateIssues.join('\n')}`
        );
      } catch (err) {
        console.error('Failed to send admin Discord alert for duplicate signup:', err.message);
      }
    }
  } catch (err) {
    console.error('Duplicate signup check failed:', err.message);
  }

  // Check for a rapid signup/cancel cycle: the same Stripe customer creating
  // multiple subscriptions within a short window (e.g. sign up, cancel,
  // sign up again, repeatedly). Never blocks the flow — just flags it.
  try {
    const customerId = session.customer;
    if (customerId) {
      const windowDays = 30;
      const windowStart = Math.floor(Date.now() / 1000) - windowDays * 24 * 60 * 60;
      const subs = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 20,
      });
      const recentSubs = subs.data.filter((s) => s.created >= windowStart);

      if (recentSubs.length >= 3) {
        const alertName = session.customer_details?.name || '';
        try {
          await sendRapidCycleAlert({
            name: alertName,
            email,
            subscriptionCount: recentSubs.length,
            windowDays,
          });
        } catch (err) {
          console.error('Failed to send rapid cycle email alert:', err.message);
        }
        try {
          await sendChannelMessage(
            process.env.ADMIN_ALERT_CHANNEL_ID,
            `🔁 **Ύποπτος κύκλος εγγραφών/ακυρώσεων**\n${alertName || email} — ${email}\n${recentSubs.length} συνδρομές μέσα σε ${windowDays} μέρες.`
          );
        } catch (err) {
          console.error('Failed to send admin Discord alert for rapid cycle:', err.message);
        }
      }
    }
  } catch (err) {
    console.error('Rapid cycle check failed:', err.message);
  }

  // Find the Discord member (to store their user ID, and to add the role)
  let discordUserId = null;
  if (discordUsername) {
    try {
      const member = await findMemberByUsername(discordUsername);
      discordUserId = member?.user?.id || null;
      if (discordUserId) {
        await addRoleToUser(discordUserId);
        console.log(`Role added to ${discordUsername} (${discordUserId})`);

        // Yearly subscribers also get the VIP role, as a recognition badge.
        if (planLabel.includes('Yearly') && process.env.DISCORD_VIP_ROLE_ID) {
          await addRoleToUser(discordUserId, process.env.DISCORD_VIP_ROLE_ID);
          console.log(`VIP role added to ${discordUsername} (yearly plan)`);
        }
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
  const tos = extractTosAcceptance(session);
  const taxCountry = session.customer_details?.address?.country || existing?.taxCountry || '';
  const rowData = {
    name: session.customer_details?.name || existing?.name || '',
    email,
    discordUsername: discordUsername || existing?.discordUsername || '',
    date: today,
    renewalDate,
    status: 'Active',
    plan: planLabel,
    amount: amount || existing?.amount || '',
    tosAccepted: tos.accepted || existing?.tosAccepted || '',
    tosVersion: tos.version || existing?.tosVersion || '',
    taxCountry,
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

  // Also post to the private admin Discord channel for immediate visibility,
  // in addition to the email alerts above.
  try {
    await sendChannelMessage(
      process.env.ADMIN_ALERT_CHANNEL_ID,
      `🟢 **Νέα συνδρομή**\n${rowData.name || '(no name)'} — ${email}\nPlan: ${planLabel}`
    );
  } catch (err) {
    console.error('Failed to send admin Discord alert for new subscription:', err.message);
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

        // Also remove the VIP role in case they had it (yearly plan) —
        // harmless no-op if they never had it.
        if (process.env.DISCORD_VIP_ROLE_ID) {
          await removeRoleFromUser(member.user.id, process.env.DISCORD_VIP_ROLE_ID);
        }
      }
    }
  } catch (err) {
    console.error('Discord role removal failed on cancellation:', err.message);
  }

  await updateRow(row.rowNumber, {
    status: 'Expired',
    expiredDate: new Date().toISOString().slice(0, 10),
  });
  console.log(`Marked row ${row.rowNumber} (${email}) as Expired (immediate cancellation)`);

  try {
    await sendSkoolRemovalAlert([{ name: row.name, email, plan: row.plan }]);
  } catch (err) {
    console.error('Failed to send Skool removal alert on cancellation:', err.message);
  }

  try {
    await sendGoodbyeEmail({ name: row.name, email });
  } catch (err) {
    console.error('Failed to send goodbye email on cancellation:', err.message);
  }

  // Also post to the private admin Discord channel for immediate visibility.
  try {
    await sendChannelMessage(
      process.env.ADMIN_ALERT_CHANNEL_ID,
      `🔴 **Ακύρωση συνδρομής**\n${row.name || '(no name)'} — ${email}\nΟ Discord ρόλος αφαιρέθηκε.`
    );
  } catch (err) {
    console.error('Failed to send admin Discord alert for cancellation:', err.message);
  }
}

/**
 * Handles an abandoned checkout: the customer started paying but never
 * completed within the session's lifetime (Stripe fires this ~24h after
 * creation if the session wasn't completed or manually expired). Only
 * sends a recovery email if Stripe actually captured an email address
 * during the attempt, and only if they haven't since become an active
 * subscriber some other way (e.g. they came back and paid via a
 * different session before this one technically "expired").
 */
async function handleCheckoutExpired(session) {
  const email = session.customer_details?.email || session.customer_email;
  if (!email) {
    console.log(`Checkout session ${session.id} expired with no email captured — nothing to recover.`);
    return;
  }

  const existing = await findRowByEmail(email);
  if (existing && existing.status.toLowerCase() === 'active') {
    console.log(`${email} already has an active subscription — skipping abandoned checkout email.`);
    return;
  }

  try {
    await sendAbandonedCheckoutEmail({ name: session.customer_details?.name || '', email });
  } catch (err) {
    console.error('Failed to send abandoned checkout email:', err.message);
  }
}

/**
 * Handles a new chargeback/dispute. Pulls whatever we know about the
 * customer (from the charge's billing details and our own sheet) and
 * sends the admin an immediate alert with a starting-point evidence draft
 * — never auto-submits anything to Stripe, since evidence needs a human
 * judgment call and can only be submitted once per dispute.
 */
async function handleDisputeCreated(dispute) {
  let charge = null;
  try {
    charge = await stripe.charges.retrieve(dispute.charge);
  } catch (err) {
    console.error(`Failed to retrieve charge ${dispute.charge} for dispute ${dispute.id}:`, err.message);
  }

  const email = charge?.billing_details?.email || null;
  const row = email ? await findRowByEmail(email) : null;

  const dueBy = dispute.evidence_details?.due_by
    ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10)
    : null;

  try {
    await sendChargebackDraftAlert({
      disputeId: dispute.id,
      amount: (dispute.amount / 100).toFixed(2),
      currency: dispute.currency.toUpperCase(),
      reason: dispute.reason,
      dueBy,
      customerName: row?.name || charge?.billing_details?.name || '',
      customerEmail: email || '',
      signupDate: row?.date || '',
      status: row?.status || '',
      plan: row?.plan || '',
      discordJoined: row?.discordJoined || '',
    });
  } catch (err) {
    console.error('Failed to send chargeback draft alert:', err.message);
  }
}

/**
 * Handles a subscription update, specifically watching for the moment
 * someone schedules a cancellation via the Stripe Customer Portal
 * (cancel_at_period_end flips from false to true). Sends a retention
 * "save offer" email — with an additional downsell (cheaper plan) option
 * if they've been subscribed 2+ months. Only fires once per cancellation
 * (tracked via "Save Offer Sent"); if they later change their mind and
 * un-cancel, the flag resets so a future cancellation can trigger it again.
 */
async function handleSubscriptionUpdated(subscription, previousAttributes) {
  const customerId = subscription.customer;
  if (!customerId) return;

  const customer = await stripe.customers.retrieve(customerId);
  const email = customer?.email;
  if (!email) return;

  const row = await findRowByEmail(email);
  if (!row) return;

  // Case 1: they just scheduled a cancellation (false -> true transition).
  const justScheduledCancellation =
    subscription.cancel_at_period_end === true && previousAttributes?.cancel_at_period_end === false;

  if (justScheduledCancellation) {
    if (row.saveOfferSent === 'Yes') return; // already sent for this cycle

    const tenureDays = daysSince(row.date);
    const eligibleForDownsell = tenureDays !== null && tenureDays >= 60; // ~2 months

    try {
      await sendSaveOfferEmail({ name: row.name, email, eligibleForDownsell });
      await updateRow(row.rowNumber, { saveOfferSent: 'Yes' });
    } catch (err) {
      console.error('Failed to send save offer email:', err.message);
    }
    return;
  }

  // Case 2: they un-cancelled (true -> false) — reset the flag so a future
  // cancellation attempt can trigger the save offer again.
  const unCancelled =
    subscription.cancel_at_period_end === false && previousAttributes?.cancel_at_period_end === true;

  if (unCancelled && row.saveOfferSent === 'Yes') {
    try {
      await updateRow(row.rowNumber, { saveOfferSent: '' });
    } catch (err) {
      console.error('Failed to reset save offer flag:', err.message);
    }
  }
}

/**
 * Handles a failed renewal payment. Only acts on `subscription_cycle`
 * invoices (i.e. actual renewals) — the first invoice at signup is not a
 * renewal, and if that one fails the customer simply retries checkout
 * themselves, so no email is needed there. The tone of the email escalates
 * based on how many attempts Stripe has already made (attempt_count) and
 * whether this was the final attempt (next_payment_attempt is null).
 */
async function handleInvoicePaymentFailed(invoice) {
  if (invoice.billing_reason !== 'subscription_cycle') {
    return;
  }

  const email = invoice.customer_email;
  if (!email) {
    console.error('Failed invoice has no customer email, skipping.');
    return;
  }

  const row = await findRowByEmail(email);
  const name = row?.name || '';
  const attemptCount = invoice.attempt_count || 1;
  const isFinalAttempt = !invoice.next_payment_attempt;

  try {
    await sendPaymentFailedEmail({ name, email, attemptCount, isFinalAttempt });
  } catch (err) {
    console.error('Failed to send payment failed email:', err.message);
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
    } else if (event.type === 'checkout.session.expired') {
      await handleCheckoutExpired(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event.data.object, event.data.previous_attributes);
    } else if (event.type === 'invoice.payment_failed') {
      await handleInvoicePaymentFailed(event.data.object);
    } else if (event.type === 'charge.dispute.created') {
      await handleDisputeCreated(event.data.object);
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
