'use strict';
// Slice 9 — Policy acknowledgement (E7 body, POL-01..04). Read the current version,
// acknowledge it, RE-ACKNOWLEDGE when a new version is published (acks are
// version-specific), and track who is still outstanding. Outstanding counts ACTIVE
// staff only (LVR-02).
const db = require('./db');
const { HttpError } = require('./errors');

async function currentVersion(c, code) {
  const r = await c.query('SELECT max(version) AS v FROM policy WHERE code=$1', [code]);
  return r.rows[0] && r.rows[0].v != null ? Number(r.rows[0].v) : null;
}
async function employeeOf(c, userId) {
  const r = await c.query('SELECT employee_id FROM app_user WHERE id=$1', [userId]);
  return r.rows[0] ? r.rows[0].employee_id : null;
}

// POL-01: publish a policy — a new publish bumps the version (re-ack required).
async function publishPolicy(session, { code, title, body }) {
  if (!code || !title) throw new HttpError(400, 'code and title required');
  return db.withTenant(session.company_id, async (c) => {
    const cur = await currentVersion(c, code);
    const version = (cur || 0) + 1;
    await c.query(
      `INSERT INTO policy (company_id, code, version, title, body) VALUES ($1,$2,$3,$4,$5)`,
      [session.company_id, code, version, title, body || null]);
    return { code, version };
  });
}

// POL-02: read the current version.
async function readCurrent(session, code) {
  return db.withTenant(session.company_id, async (c) => {
    const r = await c.query(
      'SELECT code, version, title, body, published_at FROM policy WHERE code=$1 ORDER BY version DESC LIMIT 1', [code]);
    if (!r.rows[0]) throw new HttpError(404, 'policy not found');
    return r.rows[0];
  });
}

// POL-03: acknowledge the current version (idempotent).
async function acknowledge(session, code) {
  return db.withTenant(session.company_id, async (c) => {
    const version = await currentVersion(c, code);
    if (version == null) throw new HttpError(404, 'policy not found');
    const employeeId = await employeeOf(c, session.user_id);
    if (!employeeId) throw new HttpError(403, 'no employee for user');
    await c.query(
      `INSERT INTO policy_ack (company_id, policy_code, version, employee_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, policy_code, version, employee_id) DO NOTHING`,
      [session.company_id, code, version, employeeId]);
    return { code, version, acknowledged: true };
  });
}

// POL-04: who is still outstanding on the current version (ACTIVE staff only).
async function outstanding(session, code) {
  return db.withTenant(session.company_id, async (c) => {
    const version = await currentVersion(c, code);
    if (version == null) throw new HttpError(404, 'policy not found');
    const r = await c.query(
      `SELECT count(*)::int AS n FROM employee e
        WHERE e.status='active'
          AND NOT EXISTS (SELECT 1 FROM policy_ack a
                           WHERE a.policy_code=$1 AND a.version=$2 AND a.employee_id=e.id)`,
      [code, version]);
    return { code, version, outstanding: r.rows[0].n };
  });
}

// Whether a specific employee is outstanding on the current version.
async function isOutstanding(session, code, employeeId) {
  return db.withTenant(session.company_id, async (c) => {
    const version = await currentVersion(c, code);
    const r = await c.query(
      `SELECT 1 FROM policy_ack WHERE policy_code=$1 AND version=$2 AND employee_id=$3`,
      [code, version, employeeId]);
    return r.rows.length === 0;
  });
}

module.exports = { publishPolicy, readCurrent, acknowledge, outstanding, isOutstanding };
