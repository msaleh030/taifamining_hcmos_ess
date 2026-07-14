'use strict';
// POST-RESTART SECURITY RE-VERIFICATION (Kira, 2026-07-12). Runs ON THE BOX
// against the RUNNING process over HTTP (127.0.0.1:3000) — never the service
// layer — because "verified live" before the stale-serving fix may have been
// checked against old code. Any FAIL exits 1 and fails the whole deploy.
//
//   1. RANK LATTICE (bughunt-B #3): an R03 in password.reset.owner may reset a
//      PEER-OR-LOWER account (positive control on a throwaway R01) but MUST be
//      403-refused targeting the R12 System Administrator. This is the
//      privilege-escalation fix, proven against the serving process.
//   2. LEAVE CYCLE-SCOPING (#1/#2): a probe employee with an approved request
//      in the PREVIOUS anniversary cycle and one in the CURRENT cycle must see
//      annual.taken = current-cycle days only (entitlement renews; prior-cycle
//      consumption never double-charges the new cycle).
//   3. MFA TOGGLE: GET /auth/config must match the deploy's MFA_SETUP_PHASE,
//      and in setup phase a password-only login must actually succeed (field
//      hidden AND unenforced come from the same key — no half-flip).
//
// Fixtures are created via the owner connection and REMOVED in finally; no
// secret or PII is printed (credentials come from the 600-mode matrix file).
//
//   MFA_SETUP_PHASE=1 UAT_COMPANY=<uuid> hcmos-run node scripts/probe-security.js
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('../src/db');
const C = require('../src/crypto');

const BASE = process.env.PROBE_BASE || 'http://127.0.0.1:3000';
const CREDS = process.env.PROBE_CREDS || '/root/uat-credentials.txt';
const T = () => AbortSignal.timeout(10000);

let failures = 0;
const report = (ok, name, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function latestPassword(email) {
  const creds = fs.readFileSync(CREDS, 'utf8');
  const re = /email\s*:\s*(\S+)[\s\S]*?password\s*:\s*(\S+)/g;
  const latest = new Map(); let m;
  while ((m = re.exec(creds))) latest.set(m[1], m[2]);
  return latest.get(email);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: T(),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

async function main() {
  const company = process.env.UAT_COMPANY;
  if (!company) throw new Error('set UAT_COMPANY');
  const setupPhase = (process.env.MFA_SETUP_PHASE || '1') !== '0';

  // Sweep any fixture a crashed earlier run leaked (idempotent re-runs).
  await db.withOwner(async (c) => {
    const stale = (await c.query(
      `SELECT id, employee_id FROM app_user WHERE company_id=$1
        AND (email = 'probe.cycle@taifamining.tz' OR email LIKE 'probe.lattice.%@taifamining.tz')`, [company])).rows;
    for (const u of stale) {
      await c.query(`DELETE FROM session WHERE user_id=$1`, [u.id]).catch(() => {});
      if (u.employee_id) await c.query(`DELETE FROM leave_request WHERE employee_id=$1`, [u.employee_id]);
      await c.query(`DELETE FROM app_user WHERE id=$1`, [u.id]);
      if (u.employee_id) await c.query(`DELETE FROM employee WHERE id=$1`, [u.employee_id]);
    }
  });

  // ── 3a. MFA toggle: the RUNNING process's pre-auth config ──────────────────
  const cfgRes = await api('GET', '/auth/config');
  report(cfgRes.status === 200 && cfgRes.body.mfaRequired === !setupPhase,
    'MFA toggle: /auth/config matches MFA_SETUP_PHASE',
    `mfaRequired=${cfgRes.body && cfgRes.body.mfaRequired} (setup-phase=${setupPhase ? '1' : '0'})`);

  // ── Login as the R03 probe (password-only in setup phase → also proves 3b:
  // enforcement matches the hidden field). ────────────────────────────────────
  const r03Email = 'uat.probe.r03@taifamining.tz';
  const r03Pass = latestPassword(r03Email);
  if (!r03Pass) throw new Error('probe R03 credentials not in the matrix — provision step missing?');
  const login = await api('POST', '/auth/console', { body: { email: r03Email, password: r03Pass } });
  report(login.status === 200 && !!login.body.token,
    'MFA toggle: password-only login in setup phase (enforcement mirrors the hidden field)',
    `status=${login.status}`);
  const r03 = login.body.token;

  // ── 1. Rank lattice, against the serving process ───────────────────────────
  const throwawayEmail = `probe.lattice.${crypto.randomUUID().slice(0, 8)}@taifamining.tz`;
  const throwaway = await db.withOwner(async (c) => (await c.query(
    `INSERT INTO app_user(company_id, email, password_hash, role_code, status)
     VALUES ($1,$2,$3,'R01','active') RETURNING id`,
    [company, throwawayEmail, C.hashSecret(crypto.randomUUID())])).rows[0].id);
  try {
    const admin = await db.withOwner(async (c) => (await c.query(
      `SELECT id FROM app_user WHERE company_id=$1 AND role_code='R12' AND email='rajesh.chohan@taifamining.tz'`,
      [company])).rows[0]);
    if (!admin) throw new Error('R12 admin account not found');
    // Positive control FIRST: the outer gate (password.reset.owner) admits R03
    // for a peer-or-lower target — so the refusal below can ONLY be the lattice.
    const low = await api('POST', '/auth/reset/password',
      { token: r03, body: { target_user: throwaway, new_password: crypto.randomUUID() } });
    report(low.status === 200 && low.body.ok === true,
      'rank lattice control: R03 CAN reset a lower-ranked (R01) throwaway account', `status=${low.status}`);
    const high = await api('POST', '/auth/reset/password',
      { token: r03, body: { target_user: admin.id, new_password: crypto.randomUUID() } });
    report(high.status === 403 && /rank lattice|higher-ranked/.test(String(high.body && high.body.error)),
      'rank lattice: R03 -> R12 System Administrator reset is REFUSED (privilege-escalation fix SERVING)',
      `status=${high.status} error="${high.body && high.body.error}"`);
  } finally {
    await db.withOwner((c) => c.query(`DELETE FROM session WHERE user_id=$1`, [throwaway])).catch(() => {});
    await db.withOwner((c) => c.query(`DELETE FROM app_user WHERE id=$1`, [throwaway]));
  }

  // ── 2. Leave cycle-scoping against the serving process ─────────────────────
  // Probe employee joined 2024-07-20 → the current cycle (today ~2026-07-12)
  // started 2025-07-20. A 5-day approved request BEFORE that boundary must NOT
  // count; a 2-day one inside it must. Stale (pre-fix) code counted 7.
  const probePass = crypto.randomUUID();
  const fix = await db.withOwner(async (c) => {
    const site = (await c.query(`SELECT id FROM site WHERE company_id=$1 LIMIT 1`, [company])).rows[0].id;
    const emp = (await c.query(
      `INSERT INTO employee(company_id, site_id, full_name, role_code, status, joined_at)
       VALUES ($1,$2,'Zz Cycle Probe','R01','active','2024-07-20') RETURNING id`, [company, site])).rows[0].id;
    const user = (await c.query(
      `INSERT INTO app_user(company_id, employee_id, email, password_hash, role_code, status)
       VALUES ($1,$2,'probe.cycle@taifamining.tz',$3,'R01','active') RETURNING id`,
      [company, emp, C.hashSecret(probePass)])).rows[0].id;
    await c.query(
      `INSERT INTO leave_request(company_id, employee_id, leave_type, days, status, applied_at)
       VALUES ($1,$2,'annual',5,'approved','2025-01-10'), ($1,$2,'annual',2,'approved','2026-01-10')`,
      [company, emp]);
    return { emp, user };
  });
  try {
    const probeLogin = await api('POST', '/auth/console', { body: { email: 'probe.cycle@taifamining.tz', password: probePass } });
    if (probeLogin.status !== 200) throw new Error(`cycle-probe login failed (${probeLogin.status})`);
    const bal = await api('GET', '/leave/balance', { token: probeLogin.body.token });
    const taken = bal.body && bal.body.annual && bal.body.annual.taken;
    report(bal.status === 200 && Number(taken) === 2,
      'leave cycle-scoping: prior-cycle consumption does NOT charge the renewed entitlement',
      `annual.taken=${taken} (want 2 — the current cycle only; stale code said 7)`);
  } finally {
    await db.withOwner(async (c) => {
      await c.query(`DELETE FROM session WHERE user_id=$1`, [fix.user]).catch(() => {});
      await c.query(`DELETE FROM leave_request WHERE employee_id=$1`, [fix.emp]);
      await c.query(`DELETE FROM app_user WHERE id=$1`, [fix.user]);
      await c.query(`DELETE FROM employee WHERE id=$1`, [fix.emp]);
    });
  }

  await db.close();
  if (failures) { console.log(`${failures} security probe(s) FAILED — failing the deploy`); process.exit(1); }
  console.log('ALL SECURITY PROBES PASS (verified against the RUNNING process)');
}

main().catch((e) => { console.error('[probe-security] FATAL:', e.message); process.exit(1); });
