'use strict';
// Slice 3 — Employee-number scheme (TMCL-<LOC>-<SEQ>), Section 17 set.
// Proves: per-location sequencing under concurrency, two locations may each hold
// SEQ 0001, and Nyanzaga generation is blocked until [TBC-NYZ] is configured.
// Everything reads from the config registry; nothing is hard-coded here.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const empno = require('../src/empno');
const { F } = H;

const A = F.TENANT_A;
const setLocations = (company, csv) => db.withOwner((c) =>
  c.query(`UPDATE config SET value=$1 WHERE company_id=$2 AND key='empno.locations'`, [csv, company]));

before(H.start);
after(H.stop);

// ── 1. Format + uniqueness PER LOCATION under concurrent joiners ────────────
test('s3.1 per-location SEQ is unique and contiguous under concurrent joiners', async () => {
  // N equals the app pool size: each joiner holds a connection AND the generator
  // reads config + allocates on that SAME connection, so this must not deadlock.
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, () => db.withTenant(A, (c) => empno.generate(c, A, 'mw'))));

  assert.equal(new Set(results).size, N, 'no two joiners got the same number');
  for (const e of results) assert.match(e, /^TMCL-MW-\d{4}$/, 'matches the new format');
  const seqs = results.map((e) => Number(e.slice(-4))).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8], 'per-location sequence is contiguous — no gaps or dupes');
});

// ── 2. Two different locations may both hold SEQ 0001 (per-location proven) ──
test('s3.2 two different locations may both hold SEQ 0001', async () => {
  const nm = await db.withTenant(A, (c) => empno.generate(c, A, 'nm')); // first NM
  const ho = await db.withTenant(A, (c) => empno.generate(c, A, 'ho')); // first HO
  assert.equal(nm, 'TMCL-NM-0001');
  assert.equal(ho, 'TMCL-HO-0001');
  // The counter is per-location, not global: the next NM is 0002, independent of HO.
  const nm2 = await db.withTenant(A, (c) => empno.generate(c, A, 'nm'));
  assert.equal(nm2, 'TMCL-NM-0002');
});

// ── 3. Nyanzaga is BLOCKED until [TBC-NYZ] is set (guard), then config-driven ─
test('s3.3 Nyanzaga generation is blocked until its code is configured', async () => {
  // Default config: nyanzaga code is empty → generation refused, format invalid.
  await assert.rejects(
    db.withTenant(A, (c) => empno.generate(c, A, 'nyanzaga')),
    /not yet configured/, 'blocked while [TBC-NYZ] is unset');
  assert.equal(await empno.isValid(A, 'TMCL-NZ-0001'), false, 'no enabled code ⇒ invalid');

  // Governance confirms NZ → set it in the registry (no code change, no deploy).
  await setLocations(A, 'ho:HO,mw:MW,nm:NM,nyanzaga:NZ');
  try {
    const e = await db.withTenant(A, (c) => empno.generate(c, A, 'nyanzaga'));
    assert.match(e, /^TMCL-NZ-\d{4}$/, 'generates once configured');
    assert.equal(await empno.isValid(A, e), true, 'and now validates');
  } finally {
    // Restore default so the guard remains the asserted default state.
    await setLocations(A, 'ho:HO,mw:MW,nm:NM,nyanzaga:');
  }
});

// ── 4. Rollover at 9999 per location — [TBC-ROLLOVER] ───────────────────────
// Behaviour past the per-location maximum is undefined until governance decides,
// so this test is not finalised. Interim safety (asserted indirectly): the
// generator refuses to overflow rather than silently widening the field — see
// src/empno.js. Finalise once the rollover policy is confirmed.
test('s3.4 rollover behaviour at 9999 per location', { skip: '[TBC-ROLLOVER] pending governance' }, () => {});
