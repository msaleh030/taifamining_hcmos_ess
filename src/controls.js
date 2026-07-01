'use strict';
// Slice 9 — Controls & Checker (C20 body, AC-AUD-03). Runs the standing checks and
// returns the OFFENDING RECORDS per check (not just pass/fail), wired onto the
// existing SoD/maker-checker data, attendance evidence, access state, and the
// audit-chain verifier.
const db = require('./db');

// The audit-chain verifier (same recompute the Section-17 audit test uses).
const AUDIT_VERIFY = `
  SELECT seq FROM audit
   WHERE hash <> encode(sha256(convert_to(prev_hash || concat_ws('|',
     company_id::text, coalesce(actor,''), coalesce(role,''), action,
     coalesce(entity,''), coalesce(entity_id,''), ts::text,
     coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')
   ORDER BY seq`;

async function runControls(session) {
  return db.withTenant(session.company_id, async (c) => {
    const checks = [];
    const add = (check, rows) => checks.push({ check, pass: rows.length === 0, offenders: rows });

    // 1. SoD breach — an APPROVED field change whose checker is also the maker.
    add('sod.self_approval', (await c.query(
      `SELECT id, employee_id, field, maker, checker FROM field_change
        WHERE status='approved' AND checker IS NOT NULL AND checker = maker`)).rows);

    // 2. Attendance with no location evidence.
    add('attendance.no_location', (await c.query(
      `SELECT id, employee_id, punched_at FROM attendance
        WHERE lat IS NULL OR lng IS NULL`)).rows);

    // 3. Access still held by leavers (LVR-01) — active login, terminated employee.
    add('access.leaver_retained', (await c.query(
      `SELECT u.id AS user_id, u.email, e.id AS employee_id, e.status
         FROM app_user u JOIN employee e ON e.id = u.employee_id
        WHERE u.status='active' AND e.status='terminated'`)).rows);

    // 4. Audit-chain integrity — rows whose stored hash no longer recomputes.
    add('audit.chain_integrity', (await c.query(AUDIT_VERIFY)).rows);

    return { checks, all_pass: checks.every((x) => x.pass) };
  });
}

module.exports = { runControls };
