'use strict';
// Slice 7 — KPI compute. RAG thresholds, role-scoped scorecard (A2/A3), personal
// My KPIs (E8, self only), leaver exclusion (LVR-02), not-available cards for
// uncaptured inputs (never zero), and a hand-calculated fixture (tenant B).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const kpi = require('../src/kpi');
const { F } = H;

const A = F.TENANT_A;
const B = F.TENANT_B;
const r11 = { company_id: A, user_id: F.USERS.DIRECTOR_A.id, role_code: 'R11' };
const r05 = { company_id: A, user_id: F.USERS.HSE5_A.id, role_code: 'R05' };
const r01 = { company_id: A, user_id: F.USERS.EMP_A.id, role_code: 'R01' };
const bSess = { company_id: B, user_id: F.USERS.BOB_B.id, role_code: 'R11' };

const setCfg = (co, key, value) => db.withOwner((c) =>
  c.query('UPDATE config SET value=$1 WHERE company_id=$2 AND key=$3', [value, co, key]));

before(H.start);
after(H.stop);

test('RAG thresholds — up and down directions', () => {
  const up = { direction: 'up', target: 100, green: 0.95, amber: 0.85 };
  assert.equal(kpi.ragFor(up, 100).rag, 'green');
  assert.equal(kpi.ragFor(up, 90).rag, 'amber');
  assert.equal(kpi.ragFor(up, 50).rag, 'red');
  const down = { direction: 'down', target: 10, green: 5, amber: 15 };
  assert.equal(kpi.ragFor(down, 3).rag, 'green');
  assert.equal(kpi.ragFor(down, 12).rag, 'amber');
  assert.equal(kpi.ragFor(down, 20).rag, 'red');
});

test('role-scope: each role sees only the KPIs it owns; scorecard is feature-flagged', async () => {
  // Flag off → scorecard not active (engine still exists).
  const off = await kpi.scorecard(r11);
  assert.equal(off.enabled, false);
  assert.equal(off.cards.length, 0);

  await setCfg(A, 'analytics.enabled', 'true');
  try {
    const sc11 = await kpi.scorecard(r11);
    const sc05 = await kpi.scorecard(r05);
    const sc01 = await kpi.scorecard(r01);
    const ids = (sc) => sc.cards.map((c) => c.id);

    assert.equal(sc11.enabled, true);
    assert.ok(ids(sc11).includes('WF-01'), 'R11 owns Workforce');
    assert.ok(!ids(sc05).includes('WF-01'), 'R05 (HSE) does not own Workforce');
    assert.ok(ids(sc05).includes('SAF-01'), 'R05 owns Safety');
    assert.ok(!ids(sc11).includes('SAF-01'), 'R11 does not own Safety');
    // every card returned is genuinely owned by that role
    assert.ok(sc11.cards.every((c) => c.owners.includes('R11')));
    assert.ok(sc05.cards.every((c) => c.owners.includes('R05')));
    assert.equal(sc01.cards.length, 0, 'R01 owns no org KPIs');
  } finally {
    await setCfg(A, 'analytics.enabled', 'false');
  }
});

test('My KPIs (E8) are self only', async () => {
  // Give one employee a disciplinary record; another none.
  await db.withOwner((c) => c.query(
    `INSERT INTO disciplinary(company_id, employee_id, kind, action_type) VALUES ($1,$2,'verbal','verbal')`,
    [A, F.EMP.DAVE]));
  try {
    const daveMy = await kpi.myKpis({ company_id: A, user_id: F.USERS.SITE2_A.id, role_code: 'R01' });
    const hoMy = await kpi.myKpis({ company_id: A, user_id: F.USERS.HO_A.id, role_code: 'R03' });
    const disc = (my) => my.cards.find((c) => c.id === 'MY-02');

    assert.equal(daveMy.employee_id, F.EMP.DAVE);
    assert.equal(disc(daveMy).value, 1, 'sees own disciplinary record');
    assert.equal(disc(hoMy).value, 0, 'another employee sees only their own (zero)');
  } finally {
    await db.withOwner((c) => c.query(
      `DELETE FROM disciplinary WHERE employee_id=$1 AND action_type='verbal' AND detail IS NULL`, [F.EMP.DAVE]));
  }
});

test('LVR-02: a population KPI counts ACTIVE staff only (leavers excluded)', async () => {
  const card = await kpi.computeOne(r11, 'WF-01');
  const active = Number((await db.withOwner((c) => c.query(
    `SELECT count(*)::int n FROM employee WHERE company_id=$1 AND status='active'`, [A]))).rows[0].n);
  const all = Number((await db.withOwner((c) => c.query(
    `SELECT count(*)::int n FROM employee WHERE company_id=$1`, [A]))).rows[0].n);
  assert.equal(card.value, active, 'headcount equals the active population');
  assert.ok(active < all, 'suspended/terminated staff are excluded from the population');
});

test('missing-input KPI renders not-available (input named), never zero', async () => {
  const card = await kpi.computeOne(r11, 'ENG-01'); // survey scores not captured
  assert.equal(card.available, false);
  assert.equal(card.status, 'not-available');
  assert.equal(card.missing, 'survey scores');
  assert.ok(!('value' in card), 'never a zero or guessed value');
});

test('computed value matches a hand-calculated fixture (tenant B)', async () => {
  // Tenant B has exactly one active employee and no disciplinary records.
  const hc = await kpi.computeOne(bSess, 'WF-01');
  assert.equal(hc.value, 1);
  assert.equal(hc.rag, 'red', '1 of a 5000 target');

  const disc = await kpi.computeOne(bSess, 'DISC-01');
  assert.equal(disc.value, 0);
  assert.equal(disc.rag, 'green', 'zero disciplinary actions');
});
