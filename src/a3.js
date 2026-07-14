'use strict';
// Addendum A3 — confidential-field visibility, enforced server-side on every
// profile read. The rule (C5, centre of gravity of Slice 2): a field the viewer
// may NOT see is ABSENT from the JSON — never masked, never null-with-a-flag.
//
// Confidential data lives in separate tables, so "not permitted" means the join
// is simply not performed: the key cannot appear, and (per Section 17.2) no
// query is issued against employee_pay / employee_medical for that read.
const cfg = require('./config');

// Non-confidential directory/profile fields — always present. `position` (job
// title), level, employment_type and the reporting split are directory-visible
// identity, like dept/site (Kira tiering, 2026-07-12).
const BASE_FIELDS = [
  'id', 'emp_no', 'full_name', 'role_code', 'site_id', 'dept', 'position', 'status',
  'phone', 'email', 'home_address', 'joined_at',
  'level', 'employment_type', 'reports_to_title', 'manager_id',
];

async function permittedSets(companyId) {
  return {
    pay: await cfg.getRoleSet(companyId, 'a3.pay.roles', 'R07,R11,R15,R16'),
    medical: await cfg.getRoleSet(companyId, 'a3.medical.roles', 'R03,R06'),
    disciplinary: await cfg.getRoleSet(companyId, 'a3.disciplinary.roles', 'R06,R07,R11'),
    // Kira 2026-07-09: national_id is a CORE HR IDENTIFIER, not financial data —
    // HR-visible (R03 and up + payroll), while tin/bank stay behind the pay gate.
    national_id: await cfg.getRoleSet(companyId, 'a3.national_id.roles', 'R03,R04,R07,R11'),
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
    // TIN + bank + the PII block stay behind the pay gate (Kira 2026-07-12:
    // tin/bank/passport/nssf/dob/address/next-of-kin = pay/PII-gated).
    const r = await client.query(
      `SELECT basic_pay, bank_name, bank_account, tin, dob, gender, bank_branch, account_name,
              passport_number, citizenship, work_permit_number, work_permit_validity, nssf_number,
              personal_email, full_address, nok_relationship, nok_name, nok_contact
         FROM employee_pay WHERE employee_id=$1`, [emp.id]);
    const row = r.rows[0] || {};
    for (const k of ['basic_pay', 'bank_name', 'bank_account', 'tin', 'dob', 'gender', 'bank_branch',
      'account_name', 'passport_number', 'citizenship', 'work_permit_number', 'work_permit_validity',
      'nssf_number', 'personal_email', 'full_address', 'nok_relationship', 'nok_name', 'nok_contact']) {
      out[k] = row[k] != null ? row[k] : null;
    }
  }

  // national_id: HR-visible tier (its OWN role set, wider than pay). Stored in
  // employee_pay for locality, but this read selects ONLY the identifier — a
  // permitted HR role never touches the pay columns.
  if (sets.national_id.has(role)) {
    const r = await client.query('SELECT national_id FROM employee_pay WHERE employee_id=$1', [emp.id]);
    out.national_id = r.rows[0] ? r.rows[0].national_id : null;
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

  // Wave 5 (confidentiality forensics): a CONFIDENTIAL disclosure leaves a trail
  // — who read which confidential blocks of whose record. A base-directory-only
  // read is NOT logged (no confidential field crossed the boundary), so ordinary
  // directory browsing does not flood the chain. Forward-only: a normal
  // audit_append, so the hash chain extends by construction — the same spirit as
  // the source_ip/mfa forensic add. Reads of 1,029 people's pay/medical/
  // disciplinary records must not be invisible.
  const disclosed = [];
  if (sets.pay.has(role)) disclosed.push('pay');
  if (sets.national_id.has(role)) disclosed.push('national_id');
  if (sets.medical.has(role)) disclosed.push('medical');
  if (sets.disciplinary.has(role)) disclosed.push('disciplinary');
  if (disclosed.length) {
    await client.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      session.company_id, String(session.user_id || session.device_id || 'system'), role,
      'profile.read', 'employee', String(emp.id), null, { blocks: disclosed }]);
  }

  return out;
}

module.exports = { assembleProfile, permittedSets, BASE_FIELDS };
