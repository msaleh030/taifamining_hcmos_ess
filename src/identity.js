'use strict';
// The ONE session→employee resolver (ESS-3, Kira 2026-07-14). A console
// session resolves through app_user; a FIELD session on the no-app_user
// bootstrap path (device maps to an employee with no console account — the
// normal case for the 1,099 field workers) resolves through its DEVICE.
//
// Before this module, three private copies of employeeOf (attendance, leave,
// payslip) looked ONLY at app_user — so a bootstrap worker could sign in but
// not clock in, apply for leave, or read their own payslip ("no employee for
// user"). The ESS-3/4 live probe caught it: the whole field track hangs off
// this resolution. Session status/device revocation is already enforced
// upstream by auth_lookup_session (migrations 022 + 039).
async function employeeOf(client, session) {
  if (session.user_id) {
    const r = await client.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id]);
    if (r.rows[0] && r.rows[0].employee_id) return r.rows[0].employee_id;
  }
  if (session.device_id) {
    const r = await client.query('SELECT employee_id FROM device WHERE id=$1', [session.device_id]);
    if (r.rows[0]) return r.rows[0].employee_id;
  }
  return null;
}

// employeeOf plus the joining date (the leave-cycle anchor) in one read —
// same resolution order: app_user first, then the session's device.
async function employeeRowOf(client, session) {
  if (session.user_id) {
    const r = await client.query(
      `SELECT u.employee_id AS id, e.joined_at::text AS joined
         FROM app_user u LEFT JOIN employee e ON e.id = u.employee_id WHERE u.id=$1`, [session.user_id]);
    if (r.rows[0] && r.rows[0].id) return r.rows[0];
  }
  if (session.device_id) {
    const r = await client.query(
      `SELECT d.employee_id AS id, e.joined_at::text AS joined
         FROM device d LEFT JOIN employee e ON e.id = d.employee_id WHERE d.id=$1`, [session.device_id]);
    if (r.rows[0] && r.rows[0].id) return r.rows[0];
  }
  return null;
}

module.exports = { employeeOf, employeeRowOf };
