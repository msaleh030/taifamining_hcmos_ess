'use strict';
// E6 — ESS payslip (PRT-02): the caller's OWN published pay, read back from the
// Exact publish (C18). A payslip exists in ESS only after its batch is
// PUBLISHED and the ESS push leg has POSTED (the C18 artifact) — staged or
// GL-only batches are invisible here.
//
// OWN-ONLY BY CONSTRUCTION: there is no employee parameter. The row is keyed by
// the session's own employee (app_user → employee), so a payslip is never
// returned to anyone but its owner — this endpoint widens NOTHING: a3.pay.roles
// still gates everyone ELSE's pay everywhere else.
//
// Wording is law (design E6): the gross column reads "Total Pay" (never "Total
// Allowance" — the file's label at that position is a misnomer, v1.5) and
// Net Pay = Total Pay − Total Deduction (the per-row EXACT-07 identity, already
// enforced at ingest).
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => Math.round(n * 100) / 100;

async function employeeOf(c, session) {
  if (!session.user_id) return null;
  const r = await c.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id]);
  return r.rows[0] ? r.rows[0].employee_id : null;
}

// The caller's ESS-visible payslip rows, newest first.
async function ownRows(c, empId) {
  return (await c.query(
    `SELECT r.id AS row_id, r.cells, b.id AS batch_id, b.period, b.version,
            b.published_at::text AS published_at
       FROM exact_row r JOIN exact_batch b ON b.id = r.batch_id
      WHERE r.matched_employee = $1 AND b.status = 'published'
        AND EXISTS (SELECT 1 FROM ess_push p WHERE p.batch_id = b.id)
      ORDER BY b.published_at DESC, b.period DESC`, [empId])).rows;
}

async function cols(c, co) {
  return {
    gross: await cfg.getInt(co, 'exact.col.gross', 27, c),
    td: await cfg.getInt(co, 'exact.col.total_deduction', 42, c),
    net: parseInt(String(await cfg.getConfig(co, 'exact.netpay.source', 'col:44', c)).split(':')[1], 10),
  };
}

// GET /me/payslips — the caller's published periods (the large-data state:
// history of periods). Empty list = the empty state, not an error.
async function listOwn(session) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const k = await cols(c, co);
    const periods = (await ownRows(c, empId)).map((r) => ({
      batch_id: r.batch_id,
      period: r.period,
      published_at: r.published_at,
      net_pay: round2(num(r.cells[k.net])),
    }));
    return { periods };
  });
}

// GET /me/payslip[?batch=…] — the newest payslip, or one period from the
// caller's own history. A batch id that is not the caller's own published row
// is a 404 (never a different person's payslip, and no existence oracle).
async function getOwn(session, batchId) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const empId = await employeeOf(c, session);
    if (!empId) throw new HttpError(403, 'no employee for user');
    const rows = await ownRows(c, empId);
    const row = batchId ? rows.find((r) => r.batch_id === batchId) : rows[0];
    if (batchId && !row) throw new HttpError(404, 'no payslip');
    if (!row) return { payslip: null }; // empty state: no payslip yet

    const k = await cols(c, co);
    const contract = (await c.query(
      `SELECT position, section, header FROM exact_column WHERE version=$1 ORDER BY position`,
      [row.version])).rows;
    const items = (section, excl) => contract
      .filter((col) => col.section === section && !excl.includes(col.position))
      .map((col) => ({ label: col.header, amount: round2(num(row.cells[col.position])) }))
      .filter((it) => it.amount !== 0);

    const totalPay = round2(num(row.cells[k.gross]));
    const totalDeduction = round2(num(row.cells[k.td]));
    const emp = (await c.query(
      'SELECT emp_no, full_name FROM employee WHERE id=$1', [empId])).rows[0] || {};
    return {
      payslip: {
        batch_id: row.batch_id,
        period: row.period,
        published_at: row.published_at,
        employee: { emp_no: emp.emp_no, full_name: emp.full_name },
        earnings: items('allowances', [k.gross]),
        deductions: items('deductions', [k.td]),
        totals: {
          total_pay: totalPay,                       // "Total Pay" — never "Total Allowance"
          total_deduction: totalDeduction,
          net_pay: round2(num(row.cells[k.net])),    // = Total Pay − Total Deduction (EXACT-07)
        },
      },
    };
  });
}

module.exports = { listOwn, getOwn };
