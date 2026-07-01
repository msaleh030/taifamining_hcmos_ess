'use strict';
// Payroll computations — all parameters come from the config registry.
//
// PC-1: a daily rate is a monthly amount divided by a registry divisor (30 — the
// monthly-amount → daily-value conversion; the SAME divisor leave-pay/liability
// use). This is distinct from LR-2's weeks→days (7 days/week) calendar
// conversion. The divisor is NEVER a literal in code — a change in the registry
// changes every computation.
// PC-3: the gross "fixed allowance" components must equal PC-1's fixed-allowance
// set; both are read from the registry and checked for consistency.
// PC-2: partial-period handling is [TBC] and BLOCKS until governance sets it.
const cfg = require('./config');
const { HttpError } = require('./errors');

// PC-1 — daily rate = monthly amount / registry divisor.
async function dailyRate(companyId, monthlyAmount, exec = null) {
  const divisor = await cfg.getRequiredInt(companyId, 'payroll.daily_rate.divisor', exec);
  if (!Number.isFinite(divisor) || divisor <= 0) {
    throw new HttpError(409, 'payroll.daily_rate.divisor is not a positive integer');
  }
  return Number(monthlyAmount) / divisor;
}

// PC-1 fixed-allowance component set.
async function fixedAllowances(companyId, exec = null) {
  return cfg.getRequiredSet(companyId, 'payroll.fixed_allowances', exec);
}

// PC-3 — gross components must equal PC-1's fixed-allowance set. Returns the set
// and throws if the two registry sets disagree (a misconfiguration, not a default).
async function grossComponents(companyId, exec = null) {
  const fixed = await cfg.getRequiredSet(companyId, 'payroll.fixed_allowances', exec);
  const gross = await cfg.getRequiredSet(companyId, 'payroll.gross_components', exec);
  const equal = fixed.size === gross.size && [...gross].every((x) => fixed.has(x));
  if (!equal) {
    throw new HttpError(409, 'payroll.gross_components (PC-3) must equal payroll.fixed_allowances (PC-1)');
  }
  return gross;
}

// PC-2 — partial-period handling is [TBC]; this BLOCKS until the registry is set.
async function partialPeriodFactor(companyId, exec = null) {
  return cfg.getRequired(companyId, 'payroll.partial_period', exec);
}

module.exports = { dailyRate, fixedAllowances, grossComponents, partialPeriodFactor };
