'use strict';
// ONE storage foundation (Kira ruling 2026-07-14). Pins:
//   1. put() stores BINARY on disk (path + sha256 in the DB, never base64),
//      namespaced per tenant and kind, with an honest scan status;
//   2. the READ gate for fail-closed kinds (ESS documents): not served until
//      the scanner says CLEAN — pending/unavailable/infected refuse, named;
//   3. RETENTION REFUSES ON [TBC]: the sweep will not delete a kind whose
//      period is a pending governance ruling (punch photos — TZ PDPA), and
//      NAMES the refusal;
//   4. with a period set, the sweep unlinks the binary and KEEPS the metadata
//      row (deleted_at) as evidence.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');
const db = require('../src/db');
const storage = require('../src/storage');
const { F } = H;

const A = F.TENANT_A;
const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
const ROOT = path.join(__dirname, '..', 'var', 'test-blob');
const setCfg = (k, v) => owner(
  `INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)
   ON CONFLICT (company_id,key) DO UPDATE SET value=EXCLUDED.value`, [A, k, v]);

before(async () => {
  await H.start();
  await setCfg('storage.local.root', ROOT);
});
after(async () => {
  await owner(`DELETE FROM stored_object WHERE company_id=$1`, [A]);
  await owner(`DELETE FROM config WHERE company_id=$1 AND key IN ('storage.local.root','storage.retention.punch-photo','storage.retention.ess-doc')`, [A]);
  fs.rmSync(ROOT, { recursive: true, force: true });
  await H.stop();
});

const putOne = (kind, extra = {}) => db.withTenant(A, (c) =>
  storage.put(c, A, kind, Buffer.alloc(300, 9), { owner_entity: 't', owner_id: 'x', content_type: 'image/jpeg', ...extra }));

test('ST-1 put stores binary + metadata (path, sha256, honest scan status); unknown kind refuses', async () => {
  const s = await putOne('punch-photo');
  assert.ok(s && fs.existsSync(s.path), 'binary at rest');
  assert.ok(s.path.includes(`${A}${path.sep}punch-photo`), 'namespaced per tenant and kind');
  assert.match(s.sha256, /^[0-9a-f]{64}$/);
  const row = (await owner(`SELECT kind, size, scan_status FROM stored_object WHERE id=$1`, [s.id])).rows[0];
  assert.equal(row.kind, 'punch-photo');
  assert.equal(Number(row.size), 300);
  await assert.rejects(db.withTenant(A, (c) => storage.put(c, A, 'random-stuff', Buffer.alloc(10))),
    /unknown storage kind/, 'kinds are enumerated, never free-form');
  // soft mode (the punch path): failure returns null, never throws
  assert.equal(await db.withTenant(A, (c) => storage.put(c, A, 'nope', Buffer.alloc(10), { soft: true })), null);
});

test('ST-2 fail-closed READ gate: an ESS document is not served until the scan says CLEAN', async () => {
  const s = await putOne('ess-doc');
  // CI has no clamd: status settles to pending/unavailable → refused, NAMED.
  await new Promise((r) => setTimeout(r, 300)); // let the async scan settle
  await assert.rejects(db.withTenant(A, (c) => storage.assertServable(c, s.id)),
    /virus scan is '(pending|unavailable)'/, 'not served before CLEAN, reason named');
  await owner(`UPDATE stored_object SET scan_status='clean' WHERE id=$1`, [s.id]);
  const served = await db.withTenant(A, (c) => storage.assertServable(c, s.id));
  assert.equal(served, s.path, 'clean serves the path');
  await owner(`UPDATE stored_object SET scan_status='infected' WHERE id=$1`, [s.id]);
  await assert.rejects(db.withTenant(A, (c) => storage.assertServable(c, s.id)), /infected/);
});

test('ST-3 retention REFUSES on [TBC] naming the governance hold; with a period set it sweeps and keeps evidence', async () => {
  const s = await putOne('punch-photo');
  await owner(`UPDATE stored_object SET created_at = now() - interval '400 days' WHERE id=$1`, [s.id]);

  // [TBC] (the default): refuse, name it, delete NOTHING.
  const r1 = await storage.retentionSweep(A);
  const refusedKinds = r1.refused.map((x) => x.kind).sort();
  assert.deepEqual(refusedKinds, ['ess-doc', 'punch-photo'], 'both kinds gated on the pending ruling');
  assert.match(r1.refused[0].reason, /governance ruling/, 'the refusal says WHY');
  assert.ok(fs.existsSync(s.path), 'nothing deleted while the period is [TBC]');

  // Kira sets a period → the old object sweeps; binary gone, row retained.
  await setCfg('storage.retention.punch-photo', '365');
  const r2 = await storage.retentionSweep(A);
  const swept = r2.swept.find((x) => x.kind === 'punch-photo');
  assert.equal(swept.deleted, 1, 'the 400-day-old photo swept at 365 days');
  assert.ok(!fs.existsSync(s.path), 'binary unlinked');
  const row = (await owner(`SELECT deleted_at FROM stored_object WHERE id=$1`, [s.id])).rows[0];
  assert.ok(row.deleted_at, 'the metadata row remains as deletion evidence');
});
