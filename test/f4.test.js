'use strict';
// F4 — KPI scorecard + My KPIs as INTEGRATION tests through the real HTTP
// endpoints. KPI-01..04, LIAB-03 pattern (not-available), LVR-02: role-scope,
// self-only My KPIs, not-available cards, and the feature flag at the endpoint.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;
const setAnalytics = (v) => owner(`UPDATE config SET value=$1 WHERE company_id=$2 AND key='analytics.enabled'`, [v, A]);

before(H.start);
after(H.stop);

// ── Feature flag + role-scope + not-available + LVR-02, all through HTTP ─────
test('scorecard is feature-flagged at the endpoint; role-scoped; not-available; LVR-02', async () => {
  const r11 = await tok(F.USERS.DIRECTOR_A); // R11

  // Flag OFF (default) → disabled, not a partial scorecard.
  const off = await H.req('GET', '/kpi/scorecard', { token: r11 });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.deepEqual(off.body.cards, []);

  await setAnalytics('true');
  try {
    const sc11 = await H.req('GET', '/kpi/scorecard', { token: r11 });
    assert.equal(sc11.body.enabled, true);
    const ids11 = sc11.body.cards.map((c) => c.id);
    assert.ok(ids11.includes('WF-01'), 'R11 owns Workforce');
    assert.ok(!ids11.includes('SAF-01'), 'R11 does not own Safety');

    const r05 = await tok(F.USERS.HSE5_A); // R05
    const sc05 = await H.req('GET', '/kpi/scorecard', { token: r05 });
    const ids05 = sc05.body.cards.map((c) => c.id);
    assert.ok(ids05.includes('SAF-01') && !ids05.includes('WF-01'), 'R05 owns Safety, not Workforce');

    // not-available card: input named, no value (never zero)
    const eng = sc11.body.cards.find((c) => c.id === 'ENG-01');
    assert.equal(eng.available, false);
    assert.equal(eng.missing, 'survey scores');
    assert.ok(!('value' in eng), 'not-available, never a zero');

    // LVR-02: the population KPI counts active staff only
    const wf = sc11.body.cards.find((c) => c.id === 'WF-01');
    const active = Number((await owner(`SELECT count(*)::int n FROM employee WHERE company_id=$1 AND status='active'`, [A])).rows[0].n);
    assert.equal(wf.value, active, 'headcount == active population (leavers excluded)');
  } finally {
    await setAnalytics('false');
  }
});

// ── My KPIs: self only (no way to read another employee's KPIs) ─────────────
test('My KPIs returns the requester’s own cards only', async () => {
  const disc = (await owner(
    `INSERT INTO disciplinary(company_id, employee_id, kind, action_type) VALUES ($1,$2,'verbal','verbal') RETURNING id`,
    [A, F.EMP.DAVE])).rows[0].id;
  try {
    const dave = await tok(F.USERS.SITE2_A); // employee DAVE
    const mineD = await H.req('GET', '/kpi/mine', { token: dave });
    assert.equal(mineD.body.employee_id, F.EMP.DAVE);
    assert.equal(mineD.body.cards.find((c) => c.id === 'MY-02').value, 1, 'sees own disciplinary count');

    const alice = await tok(F.USERS.EMP_A); // employee ALICE
    const mineA = await H.req('GET', '/kpi/mine', { token: alice });
    assert.equal(mineA.body.employee_id, F.EMP.ALICE);
    assert.equal(mineA.body.cards.find((c) => c.id === 'MY-02').value, 0, 'another employee sees only their own');
    // (There is no /kpi/mine/:id — a caller cannot request another employee's KPIs.)
  } finally {
    await owner(`DELETE FROM disciplinary WHERE id=$1`, [disc]);
  }
});
