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

// Each control reports BOTH the offending rows AND the size of the population it
// examined (`checked`). On the all-clear path the checked-count is the audit
// evidence ("N records checked, 0 offenders") — a green with no number could just
// mean nothing was looked at; the count proves the control actually ran.
async function runControls(session) {
  const result = await db.withTenant(session.company_id, async (c) => {
    const checks = [];
    const one = async (sql) => (await c.query(`SELECT count(*)::int n FROM (${sql}) t`)).rows[0].n;
    const add = (check, checked, offenders) => checks.push({ check, checked, pass: offenders.length === 0, offenders });

    // 1. SoD breach — population: APPROVED field changes with a checker; offender:
    //    checker is also the maker (self-approval).
    const SOD_POP = `SELECT 1 FROM field_change WHERE status='approved' AND checker IS NOT NULL`;
    add('sod.self_approval', await one(SOD_POP), (await c.query(
      `SELECT id, employee_id, field, maker, checker FROM field_change
        WHERE status='approved' AND checker IS NOT NULL AND checker = maker`)).rows);

    // 2. Attendance — population: every punch; offender: no location evidence.
    add('attendance.no_location', await one('SELECT 1 FROM attendance'), (await c.query(
      `SELECT id, employee_id, punched_at FROM attendance WHERE lat IS NULL OR lng IS NULL`)).rows);

    // 3. Access — population: active logins; offender: active login on a leaver (LVR-01).
    add('access.leaver_retained', await one(
      `SELECT 1 FROM app_user u JOIN employee e ON e.id = u.employee_id WHERE u.status='active'`), (await c.query(
      `SELECT u.id AS user_id, u.email, e.id AS employee_id, e.status
         FROM app_user u JOIN employee e ON e.id = u.employee_id
        WHERE u.status='active' AND e.status='terminated'`)).rows);

    // 4. Audit-chain — population: every audit row; offender: hash no longer recomputes.
    add('audit.chain_integrity', await one('SELECT 1 FROM audit'), (await c.query(AUDIT_VERIFY)).rows);

    // 5. Ingest maker-checker identity (Kira 2026-07-14) — the ingest commit is
    //    the one path that CREATES employees and LANDS their bank details, i.e.
    //    the classic payroll-fraud pattern if a single actor holds both legs.
    //    The endpoint enforces maker≠checker at approve time; this control
    //    proves it HELD for every committed batch on record (catches raw-SQL or
    //    historic bypass). Population: committed batches; offender: the same
    //    actor on both legs, or a commit with missing provenance (fail-closed —
    //    a load whose maker or checker is unrecorded cannot be attested).
    add('sod.ingest_maker_checker', await one(`SELECT 1 FROM ingest_batch WHERE status='committed'`), (await c.query(
      `SELECT id, kind, submitted_by, committed_by, committed_at FROM ingest_batch
        WHERE status='committed'
          AND (submitted_by IS NULL OR committed_by IS NULL OR submitted_by = committed_by)`)).rows);

    return { checks, all_pass: checks.every((x) => x.pass) };
  });

  // C20: the control run is itself an audited event — the screen states "the run
  // is audited", but runControls never wrote a row, so that claim was hollow.
  // Record who ran it and the outcome summary (per-check checked/offender
  // counts, not the offender bodies — those can carry confidential identifiers).
  // Forward-only via audit_append, so the hash chain extends by construction.
  const summary = {
    all_pass: result.all_pass,
    checks: result.checks.map((x) => ({ check: x.check, checked: x.checked, offenders: x.offenders.length })),
  };
  await db.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
    session.company_id, String(session.user_id || session.device_id || 'system'),
    session.role_code || null, 'controls.run', 'controls', null, null, summary]);
  return result;
}

module.exports = { runControls };
