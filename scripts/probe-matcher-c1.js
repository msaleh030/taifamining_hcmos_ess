'use strict';
// CORRECTION 1 live probe (Kira 2026-07-14) — run ON THE UAT BOX from /opt/hcmos:
//   node scripts/probe-matcher-c1.js <company_id>
// Exercises the hard-fail matcher END TO END with raw evidence:
//   1. the ratified production lists resolve one-to-one against contract v2.0;
//   2. positive path: a valid official-layout upload STAGES over HTTP (R15);
//   3. MEDICAL flip: a zero-resolving include name → HTTP 409, raw body, and
//      the engine base computation refuses too (then config is RESTORED);
//   4. duplicate flip: a planted duplicate 'BASIC SALARY' header → HTTP 409
//      naming BOTH columns (then the planted row is DELETED);
//   5. pending gate: money in Local Conveyance → NOT AVAILABLE naming the
//      component and Cecilia's hold.
// Prints PASS/FAIL lines with raw responses; exits 1 on any FAIL. Cleans up
// its session and probe batches. Config flips restore in finally — the box is
// left exactly as found.
const path = require('node:path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const C = require(path.join(__dirname, '..', 'src', 'crypto'));
const exact = require(path.join(__dirname, '..', 'src', 'exact'));
const contractDef = require(path.join(__dirname, '..', 'src', 'exact_contract'));

const CO = process.argv[2];
if (!CO) { console.error('usage: node scripts/probe-matcher-c1.js <company_id>'); process.exit(2); }
const BASE = 'http://127.0.0.1:3000';
const INCLUDE_SIX = 'Basic Salary,Fixed Overtime,Project Allowance,Responsibility Allowance,Housing Allowance (Fixed),Transport Allowance(Fixed)';

let fails = 0;
const say = (ok, name, detail) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} | ${detail}`); };

const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (grid) => grid.map((r) => r.map(csvCell).join(',')).join('\n');

async function upload(token, period, csv) {
  const res = await fetch(`${BASE}/exact/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ period, csv }),
  });
  return { status: res.status, body: await res.text() };
}

(async () => {
  const N = contractDef.build().length;
  const headerRow = contractDef.build().map((c) => c.header);
  const dataRow = Array(N).fill('0'); dataRow[0] = 'PROBE-C1'; dataRow[1] = 'Probe Row';
  const csv = toCsv([headerRow, dataRow]);
  const session = { company_id: CO, user_id: null, role_code: 'R15' };
  const setCfg = (c, k, v) => c.query(
    `INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)
     ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [CO, k, v]);

  let token, sid;
  await db.withOwner(async (c) => {
    const u = (await c.query(
      `SELECT id FROM app_user WHERE company_id=$1 AND role_code='R15' AND status='active' ORDER BY username LIMIT 1`,
      [CO])).rows[0];
    if (!u) throw new Error('no active R15 user to mint');
    session.user_id = u.id;
    token = C.newToken();
    sid = (await c.query(
      `INSERT INTO session(company_id,user_id,role_code,token_hash,expires_at)
       VALUES ($1,$2,'R15',$3,now()+interval '1 hour') RETURNING id`,
      [CO, u.id, C.tokenHash(token)])).rows[0].id;
  });

  try {
    // 1 ── production lists resolve one-to-one
    const { include, exclude, pending } = await exact.classificationPositions(CO);
    const fmt = (m) => [...m.entries()].map(([k, v]) => `${k}@${v}`).join(' ');
    say(include.size === 6 && exclude.size === 9 && pending.size === 2,
      'ratified lists resolve 1:1 vs v2.0',
      `include(${include.size}): ${fmt(include)} | exclude(${exclude.size}): ${fmt(exclude)} | pending(${pending.size}): ${fmt(pending)}`);

    // 2 ── positive upload stages
    const pos = await upload(token, 'probe-c1-pos', csv);
    say(pos.status === 200 && /staged/.test(pos.body),
      'POST /exact/upload (R15, valid v2.0 grid)', `HTTP ${pos.status} ${pos.body}`);

    // 3 ── MEDICAL: zero-resolution refuses to run (HTTP + engine), then restore
    try {
      await db.withOwner((c) => setCfg(c, 'exact.dailyrate.include_names', `${INCLUDE_SIX},MEDICAL`));
      const med = await upload(token, 'probe-c1-med', csv);
      say(med.status === 409 && /ZERO contract columns/.test(med.body) && /MEDICAL/.test(med.body),
        'upload REFUSES on phantom include name (MEDICAL)', `HTTP ${med.status} ${med.body}`);
      let engineMsg = 'no error thrown';
      try { await exact.dailyRateBase(session, dataRow); } catch (e) { engineMsg = `${e.status} ${e.message}`; }
      say(/^409 .*ZERO contract columns/.test(engineMsg) && /MEDICAL/.test(engineMsg),
        'engine base computation refuses too', engineMsg);
    } finally {
      await db.withOwner((c) => setCfg(c, 'exact.dailyrate.include_names', INCLUDE_SIX));
    }

    // 4 ── duplicate header: ambiguous resolution names BOTH columns, then unplant
    try {
      await db.withOwner((c) => c.query(
        `INSERT INTO exact_column(version,position,section,header,pinned)
         VALUES ('v2.0', 90, 'allowances', 'BASIC SALARY', false)
         ON CONFLICT (version,position) DO NOTHING`));
      const dup = await upload(token, 'probe-c1-dup', csv);
      say(dup.status === 409 && /MORE THAN ONE contract column/.test(dup.body) && /10,90/.test(dup.body),
        'upload REFUSES on duplicated header (Basic Salary → 10,90)', `HTTP ${dup.status} ${dup.body}`);
    } finally {
      await db.withOwner((c) => c.query(`DELETE FROM exact_column WHERE version='v2.0' AND position=90`));
    }

    // 5 ── pending-Cecilia gate names the component
    const pendRow = Array(N).fill('0'); pendRow[10] = '3000'; pendRow[23] = '25000'; // Local Conveyance
    const reason = await exact.baseUnavailableReason(session, pendRow);
    say(reason != null && /pending Cecilia/.test(reason) && /Local Conveyance/.test(reason),
      'Local Conveyance money blocks the base, NAMING the hold', String(reason));

    // sanity: the clean base still computes (six components only)
    const cleanRow = Array(N).fill('0'); cleanRow[10] = '3000'; cleanRow[22] = '999'; cleanRow[15] = '999';
    const base = await exact.dailyRateBase(session, cleanRow);
    say(base === 3000, 'clean base = the six ratified components only', `base=${base} (rotation/OT money ignored)`);
  } finally {
    await db.withOwner(async (c) => {
      await c.query(`DELETE FROM exact_batch WHERE company_id=$1 AND period LIKE 'probe-c1-%'`, [CO]);
      if (sid) await c.query('DELETE FROM session WHERE id=$1', [sid]);
    });
    await db.close();
  }
  console.log(fails ? `RESULT: ${fails} FAIL` : 'RESULT: ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(1); });
