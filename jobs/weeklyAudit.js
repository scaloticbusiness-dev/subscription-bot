// jobs/weeklyAudit.js
// Runs once a week. Cross-checks the sheet against Discord roles and Stripe
// subscription status, looking for mismatches that might mean something
// went wrong silently — e.g. a webhook that failed, or a manual edit that
// wasn't followed through. Emails the admin only if it finds something.

const Stripe = require('stripe');
const { getAllRows } = require('../lib/sheets');
const { findMemberByUsername } = require('../lib/discord');
const { sendAuditReport } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function runWeeklyAudit() {
  console.log(`[${new Date().toISOString()}] Running weekly audit...`);
  const rows = await getAllRows();
  const issues = [];

  for (const row of rows) {
    if (!row.email) continue;
    const label = row.name || row.email;
    const sheetSaysActive = row.status.toLowerCase() === 'active';

    // --- Check 1: Sheet status vs actual Discord role ---
    if (row.discordUsername) {
      try {
        const member = await findMemberByUsername(row.discordUsername);
        const hasRole = Array.isArray(member?.roles) && member.roles.includes(process.env.DISCORD_ROLE_ID);

        if (member) {
          if (sheetSaysActive && !hasRole) {
            issues.push(
              `❗ ${label} (${row.discordUsername}): το sheet λέει Active αλλά ΔΕΝ έχει τον Discord ρόλο.`
            );
          } else if (!sheetSaysActive && hasRole) {
            issues.push(
              `❗ ${label} (${row.discordUsername}): το sheet λέει ${row.status} αλλά ΕΧΕΙ ακόμα τον Discord ρόλο.`
            );
          }
        }
      } catch (err) {
        console.error(`Discord check failed for ${label}:`, err.message);
      }
    }

    // --- Check 2: Sheet status vs actual Stripe subscription status ---
    try {
      const customers = await stripe.customers.list({ email: row.email, limit: 1 });
      const customer = customers.data[0];
      if (customer) {
        const subs = await stripe.subscriptions.list({
          customer: customer.id,
          status: 'all',
          limit: 5,
        });
        const hasActiveSub = subs.data.some(
          (s) => s.status === 'active' || s.status === 'trialing'
        );

        if (sheetSaysActive && !hasActiveSub) {
          issues.push(
            `⚠️ ${label}: το sheet λέει Active αλλά δεν βρέθηκε ενεργή συνδρομή στο Stripe.`
          );
        } else if (!sheetSaysActive && hasActiveSub) {
          issues.push(
            `⚠️ ${label}: το sheet λέει ${row.status} αλλά υπάρχει ΕΝΕΡΓΗ συνδρομή στο Stripe.`
          );
        }
      }
    } catch (err) {
      console.error(`Stripe check failed for ${label}:`, err.message);
    }
  }

  await sendAuditReport(issues);
  console.log(`Weekly audit complete. Found ${issues.length} issue(s).`);
}

module.exports = { runWeeklyAudit };
