// jobs/cohortAnalysis.js
// Runs monthly (bundled with the monthly report). Groups every subscription
// ever created by its signup month ("cohort"), then for each cohort works
// out what % of it was still active (not yet canceled) at each subsequent
// month offset. This is computed straight from Stripe's full subscription
// history (created + canceled_at) rather than a local database, so it
// stays accurate without needing daily snapshots.
//
// Only cohorts with at least MIN_COHORT_SIZE subscriptions are included —
// smaller cohorts produce noisy, misleading percentages (e.g. "50%
// retention" from a cohort of 2).

const { sendCohortReport } = require('../lib/email');
const { getAllSubscriptionsForCohorts } = require('../lib/stripeStats');

const MIN_COHORT_SIZE = 3;
const MAX_MONTH_OFFSET = 12; // don't compute/show more than a year out

function monthKey(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthsBetween(fromKey, toKey) {
  const [fy, fm] = fromKey.split('-').map(Number);
  const [ty, tm] = toKey.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function addMonths(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Unix-seconds timestamp for the first instant of the given "YYYY-MM" key.
 */
function monthKeyToUnixStart(key) {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, 1) / 1000;
}

/**
 * True if a subscription was active at any point during the given month
 * (i.e. it was created before that month ended, and if it was canceled,
 * that cancellation happened no earlier than the start of that month).
 * This is what "retained at month offset N" means for cohort purposes —
 * notably, a subscription created AND canceled within its own signup
 * month still counts as retained at M0 (it existed during that month).
 */
function wasActiveDuringMonth(sub, monthKeyToCheck) {
  const monthStart = monthKeyToUnixStart(monthKeyToCheck);
  const monthEnd = monthKeyToUnixStart(addMonths(monthKeyToCheck, 1));
  if (sub.created >= monthEnd) return false; // didn't exist yet during this month
  if (!sub.canceledAt) return true; // never canceled — still active
  return sub.canceledAt >= monthStart; // canceled before this month started = not retained
}

async function buildCohortTable() {
  const subs = await getAllSubscriptionsForCohorts();

  const cohorts = {}; // cohortMonthKey -> [subs]
  for (const sub of subs) {
    const key = monthKey(sub.created);
    (cohorts[key] = cohorts[key] || []).push(sub);
  }

  const currentMonthKey = monthKey(Math.floor(Date.now() / 1000));
  const cohortKeys = Object.keys(cohorts).sort();

  const table = [];
  for (const cohortKey of cohortKeys) {
    const cohortSubs = cohorts[cohortKey];
    if (cohortSubs.length < MIN_COHORT_SIZE) continue;

    const maxOffset = Math.min(monthsBetween(cohortKey, currentMonthKey), MAX_MONTH_OFFSET);
    const retention = [];
    for (let offset = 0; offset <= maxOffset; offset++) {
      const checkMonth = addMonths(cohortKey, offset);
      const retained = cohortSubs.filter((s) => wasActiveDuringMonth(s, checkMonth)).length;
      retention.push({ offset, pct: Math.round((retained / cohortSubs.length) * 100) });
    }

    table.push({ cohortKey, size: cohortSubs.length, retention });
  }

  return table;
}

async function runCohortAnalysis() {
  console.log(`[${new Date().toISOString()}] Running cohort analysis...`);
  const table = await buildCohortTable();
  await sendCohortReport(table);
  console.log(`Cohort analysis sent (${table.length} cohort(s) with >= ${MIN_COHORT_SIZE} signups).`);
  return table;
}

module.exports = { runCohortAnalysis, buildCohortTable };
