'use strict';
// Slice 3 — Employee-number scheme (TMCL-<LOC>-<SEQ>), Section 17 set.
// LOCKED: enum {HO,MW,NM,NZ}, SEQ 4-digit per-location, regex ^TMCL-(HO|MW|NM|NZ)-\d{4}$.
// Proves per-location sequencing, NZ (Nyanzaga) generation, enum enforcement, and
// that rollover past 9999 is registry-gated (blocks, not defaulted).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const empno = require('../src/empno');
const { F } = H;

const A = F.TENANT_A;
const B = F.TENANT_B;

before(H.start);
after(H.stop);

// ── 1. Per-location SEQ unique + contiguous under concurrent joiners ────────
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
  const nm2 = await db.withTenant(A, (c) => empno.generate(c, A, 'nm'));
  assert.equal(nm2, 'TMCL-NM-0002', 'counter is per-location, independent of HO');
});

// ── 3. NZ (Nyanzaga, now LOCKED) generates; codes outside the enum rejected ──
test('s3.3 NZ generates; codes outside the {HO,MW,NM,NZ} enum are rejected', async () => {
  const e = await db.withTenant(A, (c) => empno.generate(c, A, 'nyanzaga'));
  assert.match(e, /^TMCL-NZ-\d{4}$/, 'Nyanzaga = NZ, generated from the registry');
  assert.equal(await empno.isValid(A, e), true);

  // The locked enum is exactly {HO,MW,NM,NZ}: an out-of-enum code is invalid…
  assert.equal(await empno.isValid(A, 'TMCL-XX-0001'), false, 'unknown code rejected');
  assert.equal(await empno.isValid(A, 'TMCL-NZ-001'), false, '3-digit SEQ rejected');
  // …and an unknown location KEY cannot be generated.
  await assert.rejects(db.withTenant(A, (c) => empno.generate(c, A, 'atlantis')), /unknown location/);
});

// ── 4. Rollover past 9999 per location is [TBC] → BLOCKS, never defaults ─────
test('s3.4 emp_no rollover past 9999 per location is registry-gated (blocks)', async () => {
  // Drive a fresh location counter to the top of its 4-digit range.
  await db.withOwner((c) => c.query(
    `INSERT INTO empno_counter(company_id, location, next_seq) VALUES ($1,'NM',9998)
       ON CONFLICT (company_id, location) DO UPDATE SET next_seq = excluded.next_seq`, [B]));
  const last = await db.withTenant(B, (c) => empno.generate(c, B, 'nm'));
  assert.equal(last, 'TMCL-NM-9999', 'final in-range number is issued');
  // The next allocation would overflow; rollover policy is [TBC] ⇒ refuse.
  await assert.rejects(db.withTenant(B, (c) => empno.generate(c, B, 'nm')), /rollover \[TBC\]/);
});
