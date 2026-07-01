'use strict';
// C17 — Reports. A report inherits the GATE OF ITS DATA:
//   • FINANCIAL registers (Payroll, Leave-liability) inherit the C16 pay-visibility
//     gate (a3.pay.roles) — enforced at the register endpoints below; the catalogue
//     also hides them from non-pay roles so the UI matches the server rule.
//   • SITE-BOUND reports (C11 Performance — recruitment funnel / reviews, DEFERRED:
//     no data model yet) inherit the site-scope gate (src/sitescope.js). When C11
//     is built, its per-site data MUST be filtered via sitescope.scopeSite() so a
//     site-bound role sees only its own site — the gate is not re-implemented.
const db = require('./db');
const cfg = require('./config');
const exact = require('./exact');
const liability = require('./liability');
const { HttpError } = require('./errors');

const round2 = (x) => Math.round(x * 100) / 100;

// The report catalogue for the caller. Non-financial reports are visible to any
// reports-module role; the financial registers appear ONLY for pay-visibility.
async function catalogue(session) {
  const paySet = await cfg.getRoleSet(session.company_id, 'a3.pay.roles', '');
  const payVisible = paySet.has(session.role_code);
  const reports = [{ id: 'headcount', name: 'Headcount summary', financial: false }];
  if (payVisible) {
    reports.push({ id: 'payroll', name: 'Payroll register', financial: true });
    reports.push({ id: 'leave-liability', name: 'Leave-liability register', financial: true });
  }
  return { pay_visible: payVisible, reports };
}

// Payroll register — per-employee net pay for a batch (net = col AS, the EX-3
// money-certified source). Financial: the endpoint gates it to a3.pay.roles.
async function payrollRegister(session, batchId) {
  const co = session.company_id;
  const asCol = parseInt(String(await cfg.getConfig(co, 'exact.netpay.source', 'col:44')).split(':')[1], 10);
  return db.withTenant(co, async (c) => {
    const b = (await c.query('SELECT status FROM exact_batch WHERE id=$1', [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    const rows = (await c.query(
      `SELECT matched_employee, cells FROM exact_row
        WHERE batch_id=$1 AND match_status='matched' ORDER BY row_no`, [batchId])).rows;
    const lines = rows.map((r) => ({ employee_id: r.matched_employee, net: round2(exact.num(r.cells[asCol])) }));
    return { batch_id: batchId, status: b.status, lines, total: round2(lines.reduce((s, l) => s + l.net, 0)) };
  });
}

// Leave-liability register — the same figures as /liability/batch/:id, same gate.
async function leaveLiabilityRegister(session, batchId) {
  return liability.batchLiability(session, batchId);
}

module.exports = { catalogue, payrollRegister, leaveLiabilityRegister };
