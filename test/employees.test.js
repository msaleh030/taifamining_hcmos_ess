'use strict';
// Slice 2 — Employee Master. Section 17 tests #1-5 + tenant-isolation carryover
// against the new tables. AC-EMP-01/02/03, AC-UNI-02/04/05/06, SOD-03.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

before(H.start);
after(H.stop);

// ── AC-EMP-01: directory search + filter (site, department, status) ─────────
// 17.5 covers status/site filters and paging; this proves the remaining two
// directory affordances in the spec — free-text search and department filter —
// are applied server-side (in SQL), not client-side.
test('AC-EMP-01 directory: free-text search and department filter run server-side', async () => {
  const central = await H.loginConsole(F.USERS.PAYROLL_A); // R07 central, all sites

  // Search matches full_name…
  const byName = await H.req('GET', '/employees?q=Carol%20Confidential&limit=25', { token: central.body.token });
  assert.equal(byName.status, 200);
  assert.ok(byName.body.rows.length >= 1);
  assert.ok(byName.body.rows.every((r) => /carol confidential/i.test(r.full_name)));

  // …and emp_no (single OR-ed predicate), returning the same unique row.
  const byNo = await H.req('GET', '/employees?q=E-A-0002&limit=25', { token: central.body.token });
  assert.equal(byNo.status, 200);
  assert.ok(byNo.body.rows.some((r) => r.emp_no === 'E-A-0002'));

  // Department filter returns only that department, and is bounded by the page.
  const proc = await H.req('GET', '/employees?dept=Processing&limit=40', { token: central.body.token });
  assert.equal(proc.status, 200);
  assert.ok(proc.body.rows.length > 0 && proc.body.rows.length <= 40);
  assert.ok(proc.body.rows.every((r) => r.dept === 'Processing'));
  assert.ok(proc.body.next_cursor, 'large department paginates rather than full-loads');

  // Search + department compose (both predicates AND-ed in SQL).
  const both = await H.req('GET', '/employees?q=Carol&dept=Processing&limit=25', { token: central.body.token });
  assert.ok(both.body.rows.every((r) => r.dept === 'Processing' && /carol/i.test(r.full_name)));
  const wrongDept = await H.req('GET', '/employees?q=Carol&dept=Mining&limit=25', { token: central.body.token });
  assert.ok(!wrongDept.body.rows.some((r) => /carol confidential/i.test(r.full_name)),
    'department predicate is not bypassed by the search term');
});

// ── Section 17.1: confidential ABSENCE (A3), proven by key-absence ──────────
test('17.1 confidential fields are ABSENT (not masked/null) for non-permitted roles', async () => {
  const id = F.EMP.CAROL;

  // pay: R07 sees, R01 absent
  const r07 = await H.loginConsole(F.USERS.PAYROLL_A);
  const r01 = await H.loginConsole(F.USERS.EMP_A);
  const payView = (await H.req('GET', `/employees/${id}`, { token: r07.body.token })).body;
  const noPayView = (await H.req('GET', `/employees/${id}`, { token: r01.body.token })).body;
  assert.ok('basic_pay' in payView && 'bank_account' in payView);
  assert.ok(!('basic_pay' in noPayView), "absent — not == null, not '****'");
  assert.ok(!('bank_account' in noPayView));

  // medical: R06 (SHEQ Manager) sees, R02 absent
  const r05 = await H.loginConsole(F.USERS.HSE5_A);
  const r02 = await H.loginConsole(F.USERS.SUP_A);
  const medView = (await H.req('GET', `/employees/${id}`, { token: r05.body.token })).body;
  const noMedView = (await H.req('GET', `/employees/${id}`, { token: r02.body.token })).body;
  assert.ok('osha_status' in medView && 'permit_no' in medView);
  assert.ok(!('osha_status' in noMedView));

  // disciplinary: R07 sees, R02 absent
  assert.ok('disciplinary' in payView);
  assert.ok(!('disciplinary' in noMedView));
});

// ── Section 17.2: site-scope filters in SQL; out-of-site profile is 404 ─────
test('17.2 site-scoped role sees only its site; out-of-site profile is 404 with no confidential query', async () => {
  const sup = await H.loginConsole(F.USERS.SUP_A); // R02, scoped to SITE A1

  // list returns only Site-A1 rows (every page)
  let cursor = null, pages = 0;
  do {
    const url = '/employees?limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await H.req('GET', url, { token: sup.body.token });
    assert.equal(r.status, 200);
    for (const row of r.body.rows) assert.equal(row.site_id, F.SITE.A1, 'only Site-A1 rows');
    cursor = r.body.next_cursor;
    pages++;
  } while (cursor && pages < 4); // sample a few pages
  assert.ok(pages >= 1);

  // out-of-site (in-tenant) employee → 404 and NO query against confidential tables
  const log = [];
  db.setSpy((s) => log.push(s));
  const r = await H.req('GET', `/employees/${F.EMP.DAVE}`, { token: sup.body.token }); // DAVE is SITE A2
  db.setSpy(null);
  assert.equal(r.status, 404);
  assert.ok(!log.some((s) => /employee_pay|employee_medical/.test(s)),
    'no confidential table queried for an out-of-site id');
});

// ── Section 17.3: maker-checker + SoD ──────────────────────────────────────
test('17.3 maker-checker: pending does not mutate; maker≠checker enforced; approval applies', async () => {
  const maker = await H.loginConsole(F.USERS.HR_A);   // R03 (permitted maker AND checker)
  const checker = await H.loginConsole(F.USERS.HR2_A); // R04 (different permitted checker)

  const before = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker.body.token })).body.phone;
  const newPhone = '0712345678';

  const sub = await H.req('POST', `/employees/${F.EMP.CAROL}/change`,
    { token: maker.body.token, body: { field: 'phone', value: newPhone } });
  assert.equal(sub.status, 200);
  assert.equal(sub.body.status, 'pending');

  // employee.phone unchanged; pending flag present
  const mid = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker.body.token })).body;
  assert.equal(mid.phone, before, 'stored value not mutated while pending');
  assert.ok(mid.pending_changes.some((c) => c.id === sub.body.id));

  // approve as the maker → refused (SoD)
  const self = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: maker.body.token });
  assert.equal(self.status, 403, 'maker cannot be their own checker');

  // approve as a different permitted checker → applied
  const ok = await H.req('POST', `/field-change/${sub.body.id}/approve`, { token: checker.body.token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'approved');
  const applied = (await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: maker.body.token })).body;
  assert.equal(applied.phone, newPhone, 'value applied only on approval');

  // both submit and approve are on the audit chain
  const actions = await db.withOwner((c) => c.query(
    `SELECT action FROM audit WHERE entity='field_change' AND entity_id=$1 ORDER BY seq`, [sub.body.id]));
  const set = new Set(actions.rows.map((r) => r.action));
  assert.ok(set.has('employee.change.submit') && set.has('employee.change.approve'));
});

// ── Section 17.4: no-directory roles blocked server-side ───────────────────
test('17.4 no-directory roles (R12/R13/R15/R16) get 403 on every /employees route', async () => {
  for (const u of [F.USERS.CFC_A, F.USERS.FINMGR_A, F.USERS.ADMIN_A, F.USERS.FIELD_A]) {
    const s = await H.loginConsole(u);
    const list = await H.req('GET', '/employees', { token: s.body.token });
    const one = await H.req('GET', `/employees/${F.EMP.CAROL}`, { token: s.body.token });
    const docs = await H.req('GET', `/employees/${F.EMP.CAROL}/documents`, { token: s.body.token });
    assert.equal(list.status, 403, `${u.role} list`);
    assert.equal(one.status, 403, `${u.role} profile`);
    assert.equal(docs.status, 403, `${u.role} documents`);
  }
});

// ── Section 17.5: large-data — bounded, stable pages; filters hold ─────────
test('17.5 directory of 5,200 returns bounded, stable pages with filters intact', async () => {
  const central = await H.loginConsole(F.USERS.PAYROLL_A); // R07 central, sees all sites
  const pageSize = 50;

  const seen = new Set();
  let cursor = null, prevLast = '';
  for (let p = 0; p < 3; p++) {
    const url = `/employees?limit=${pageSize}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await H.req('GET', url, { token: central.body.token });
    assert.equal(r.status, 200);
    assert.ok(r.body.rows.length <= pageSize, 'never returns all 5,200');
    for (const row of r.body.rows) {
      assert.ok(!seen.has(row.id), 'stable: no row repeats across pages');
      seen.add(row.id);
      assert.ok(row.full_name >= prevLast, 'stable ascending order across pages');
    }
    if (r.body.rows.length) prevLast = r.body.rows[r.body.rows.length - 1].full_name;
    cursor = r.body.next_cursor;
    assert.ok(cursor, 'more pages available');
  }
  assert.equal(seen.size, 3 * pageSize);

  // filters still hold on the paged endpoint: status filter returns only that
  // lifecycle, and non-active employees are NOT dropped from the directory.
  const suspended = await H.req('GET', '/employees?status=suspended&limit=25', { token: central.body.token });
  assert.equal(suspended.status, 200);
  assert.ok(suspended.body.rows.length > 0, 'suspended employees still listed');
  assert.ok(suspended.body.rows.every((r) => r.status === 'suspended'));

  // site filter holds
  const siteA2 = await H.req('GET', `/employees?site=${F.SITE.A2}&limit=25`, { token: central.body.token });
  assert.ok(siteA2.body.rows.every((r) => r.site_id === F.SITE.A2));
});

// ── Carryover: Slice-1 Section-17 #1 re-asserted against the NEW tables ────
test('carryover tenant isolation: no crafted query returns a cross-tenant row from any new table', async () => {
  await db.withTenant(F.TENANT_A, async (c) => {
    for (const tbl of ['employee', 'employee_pay', 'employee_medical', 'disciplinary',
      'employee_document', 'employee_asset', 'field_change', 'site']) {
      const onlyA = await c.query(`SELECT bool_and(company_id=$1) AS ok, count(*)::int n FROM ${tbl}`, [F.TENANT_A]);
      // ok is true (all rows belong to A) or null (no rows) — never false
      assert.notEqual(onlyA.rows[0].ok, false, `${tbl} leaked a non-A row`);
      const craft = await c.query(`SELECT count(*)::int n FROM ${tbl} WHERE company_id=$1`, [F.TENANT_B]);
      assert.equal(craft.rows[0].n, 0, `${tbl} crafted cross-tenant filter returned rows`);
    }
  });

  // And via the API: a tenant-A directory role cannot fetch tenant-B's employee.
  const a = await H.loginConsole(F.USERS.PAYROLL_A);
  const r = await H.req('GET', `/employees/${F.EMP.BOB_B}`, { token: a.body.token });
  assert.equal(r.status, 404);
});
