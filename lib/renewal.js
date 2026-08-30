// lib/renewal.js
// Works out how many days a subscription lasts based on its plan name,
// and calculates the renewal (expiry) date from a start date.

function daysForPlan(planName) {
  const plan = (planName || '').toLowerCase();

  if (plan.includes('year') || plan.includes('annual') || plan.includes('yearly')) {
    return 365;
  }
  if (plan.includes('month') || plan.includes('monthly')) {
    return 30;
  }

  // Fallback: assume monthly if we don't recognise the plan name.
  return 30;
}

/**
 * @param {string|Date} startDate
 * @param {string} planName
 * @returns {string} ISO date string (YYYY-MM-DD) of the renewal date
 */
function calculateRenewalDate(startDate, planName) {
  const start = startDate ? new Date(startDate) : new Date();
  const days = daysForPlan(planName);

  const renewal = new Date(start);
  renewal.setDate(renewal.getDate() + days);

  return renewal.toISOString().slice(0, 10); // YYYY-MM-DD
}

module.exports = { calculateRenewalDate, daysForPlan };
