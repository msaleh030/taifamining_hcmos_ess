'use strict';
// Addendum A3 — confidential-field visibility, enforced server-side on every
// profile read. The rule (C5, centre of gravity of Slice 2): a field the viewer
// may NOT see is ABSENT from the JSON — never masked, never null-with-a-flag.
//
// Confidential data lives in separate tables, so "not permitted" means the join
// is simply not performed: the key cannot appear, and (per Section 17.2) no
// query is issued against employee_pay / employee_medical for that read.
const cfg = require('./config');

// Non-confidential directory/profile fields — always present.
const BASE_FIELDS = [
  'id', 'emp_no', 'full_name', 'role_code', 'site_id', 'dept', 'status',
  'phone', 'email', 'home_address', 'joined_at',
];

async function permittedSets(companyId) {
  return {
    pay: await cfg.getRoleSet(companyId, 'a3.pay.roles', 'R07,R09,R11'),
    medical: await cfg.getRoleSet(companyId, 'a3.medical.roles', 'R05,R06,R10'),
    disciplinary: await cfg.getRoleSet(companyId, 'a3.disciplinary.roles', 'R05,R06,R07,R11'),
  };
}

// Build a profile for `emp` as seen by `session.role_code`, using an RLS-scoped
// client. Only permitted confidential tables are queried.
async function assembleProfile(client, session, emp) {
  const role = session.role_code;
  const sets = await permittedSets(session.company_id);

  const out = {};
  for (const f of BASE_FIELDS) if (f in emp) out[f] = emp[f];

  if (sets.pay.has(role)) {
    const r = await client.query(
      'SELECT basic_pay, bank_name, bank_account FROM employee_pay WHERE employee_id=$1', [emp.id]);
    const row = r.rows[0] || { basic_pay: null, bank_name: null, bank_account: null };
    out.basic_pay = row.basic_pay; out.bank_name = row.bank_name; out.bank_account = row.bank_account;
  }

  if (sets.medical.has(role)) {
    const r = await client.query(
      'SELECT osha_status, permit_no, permit_expiry FROM employee_medical WHERE employee_id=$1', [emp.id]);
    const row = r.rows[0] || { osha_status: null, permit_no: null, permit_expiry: null };
    out.osha_status = row.osha_status; out.permit_no = row.permit_no; out.permit_expiry = row.permit_expiry;
  }

  if (sets.disciplinary.has(role)) {
    const r = await client.query(
      `SELECT id, kind, detail, issued_by, issued_at FROM disciplinary
        WHERE employee_id=$1 ORDER BY issued_at DESC`, [emp.id]);
    out.disciplinary = r.rows;
  }

  // Pending edits are surfaced as a FLAG, never by mutating the stored value.
  const pend = await client.query(
    `SELECT id, field, after, status FROM field_change
      WHERE employee_id=$1 AND status='pending' ORDER BY created_at`, [emp.id]);
  out.pending_changes = pend.rows;

  return out;
}

module.exports = { assembleProfile, permittedSets, BASE_FIELDS };
