'use strict';
// Wave 9 (2026-07-14): build-gap closures for production-reachable paths.
//   1. ingest preview: a non-array control_totals is a clean 400, never a 500
//      (the for..of in normSupplied used to throw a raw TypeError).
//   2. ingest approve: a malformed batch_id is a clean 400 (used to reach the
//      ::uuid cast → Postgres 22P02 → 500); a well-formed-but-absent id is 404.
//   3. controls.run is now an audited event (the screen claims it is) — a
//      controls.run row is appended and the hash chain still recomputes.
//   4. GET /audit: the tamper-evident chain has an application read surface,
//      restricted to the oversight set (R11/R12), paged and filterable; a
//      non-oversight role is 403.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const F = require('./fixtures');
const db = require('../src/db');

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const tok = async (u) => (await H.loginConsole(u)).body.token;

before(H.start);
after(H.stop);

test('1. ingest preview: a non-array control_totals is a clean 400 (never a 500)', async () => {
  const maker = await tok(F.USERS.FINMGR_A); // R15 ∈ ingest.roles
  // control_totals must be an array of per-site rows; an object is malformed input.
  const r = await H.req('POST', '/ingest/opening-balance/preview',
    { token: maker, body: { rows: [], control_totals: { site: 'NM', count: 5 } } });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error || '', /control_totals must be an array/);

  // A scalar is equally malformed → 400, not 500.
  const r2 = await H.req('POST', '/ingest/opening-balance/preview',
    { token: maker, body: { rows: [], control_totals: 5 } });
  assert.equal(r2.status, 400, JSON.stringify(r2.body));

  // The happy path (a proper array, or omitted) still previews cleanly.
  const ok = await H.req('POST', '/ingest/opening-balance/preview',
    { token: maker, body: { rows: [], control_totals: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('2. ingest approve: malformed batch_id → 400; well-formed-but-absent → 404 (never a 500)', async () => {
  const checker = await tok(F.USERS.CFC_A); // R16 ∈ ingest.checker.roles
  // A malformed batch_id used to reach the ::uuid cast → 22P02 → 500.
  const bad = await H.req('POST', '/ingest/opening-balance/commit',
    { token: checker, body: { batch_id: 'not-a-uuid' } });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  assert.match(bad.body.error || '', /invalid batch_id/);

  // A well-formed but non-existent id is the honest 404 (batch not found).
  const absent = await H.req('POST', '/ingest/opening-balance/commit',
    { token: checker, body: { batch_id: 'b0000000-0000-0000-0000-0000000000ff' } });
  assert.equal(absent.status, 404, JSON.stringify(absent.body));
});

test('3. controls.run is audited: running the controls appends a controls.run row; chain recomputes', async () => {
  const oversight = await tok(F.USERS.DIRECTOR_A); // R11 ∈ controls.view.roles
  const before = (await owner(`SELECT coalesce(max(seq),0)::int n FROM audit WHERE company_id=$1`, [A])).rows[0].n;
  const run = await H.req('GET', '/controls', { token: oversight });
  assert.equal(run.status, 200, JSON.stringify(run.body));

  const rec = (await owner(
    `SELECT role, after FROM audit
      WHERE company_id=$1 AND action='controls.run' AND seq>$2 ORDER BY seq DESC LIMIT 1`, [A, before])).rows[0];
  assert.ok(rec, 'a controls.run audit row was appended for the control run');
  assert.equal(rec.role, 'R11');
  assert.equal(typeof rec.after.all_pass, 'boolean', 'the run outcome summary is recorded');
  assert.ok(Array.isArray(rec.after.checks) && rec.after.checks.length >= 1, 'per-check summary is recorded');
  // The offender BODIES are not stored on the audit row (they can carry confidential ids) — only counts.
  assert.ok(rec.after.checks.every((c) => typeof c.offenders === 'number'), 'only offender counts, not bodies');

  const chainOk = (await owner(`
    SELECT bool_and(hash = encode(sha256(convert_to(prev_hash || concat_ws('|',
      company_id::text, coalesce(actor,''), coalesce(role,''), action,
      coalesce(entity,''), coalesce(entity_id,''), ts::text,
      coalesce(before::text,''), coalesce(after::text,'')), 'UTF8')),'hex')) AS ok
      FROM audit WHERE company_id=$1`, [A])).rows[0].ok;
  assert.equal(chainOk, true, 'audit chain recompute holds after the controls.run row');
});

test('4. GET /audit: oversight-only read surface, filterable + paged; non-oversight is 403', async () => {
  // A non-oversight role cannot read the audit surface.
  const pay = await tok(F.USERS.PAYROLL_A); // R07 ∉ controls.view.roles
  assert.equal((await H.req('GET', '/audit', { token: pay })).status, 403, 'R07 is refused the audit surface');

  const oversight = await tok(F.USERS.DIRECTOR_A); // R11
  // Seed a known row by running the controls, then read it back by filter.
  await H.req('GET', '/controls', { token: oversight });

  const filtered = await H.req('GET', '/audit?action=controls.run&limit=5', { token: oversight });
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.ok(Array.isArray(filtered.body.rows), 'rows is an array');
  assert.ok(filtered.body.rows.length >= 1, 'the controls.run row is visible');
  assert.ok(filtered.body.rows.every((r) => r.action === 'controls.run'), 'the action filter is honoured');
  // Newest-first ordering (seq is a bigint — may arrive as a string; compare numerically).
  for (let i = 1; i < filtered.body.rows.length; i++)
    assert.ok(Number(filtered.body.rows[i - 1].seq) > Number(filtered.body.rows[i].seq), 'rows are newest-first by seq');

  // Paging: limit=1 returns a single row and a next_before cursor to page back.
  const page = await H.req('GET', '/audit?limit=1', { token: oversight });
  assert.equal(page.status, 200);
  assert.equal(page.body.rows.length, 1, 'limit is honoured');
  assert.equal(page.body.limit, 1);
  assert.ok(Number.isFinite(Number(page.body.next_before)), 'a next_before cursor is returned when the page is full');
  // The cursor pages strictly backwards.
  const page2 = await H.req('GET', `/audit?limit=1&before=${page.body.next_before}`, { token: oversight });
  assert.equal(page2.status, 200);
  assert.ok(page2.body.rows.length === 0 || Number(page2.body.rows[0].seq) < Number(page.body.rows[0].seq), 'before= pages strictly backwards');

  // A malformed before= is a clean 400, never a 500.
  assert.equal((await H.req('GET', '/audit?before=abc', { token: oversight })).status, 400, 'malformed before → 400');
});
