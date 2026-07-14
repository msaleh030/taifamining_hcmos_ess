'use strict';
// The UAT data-load CLI (scripts/load-ingest.js) — the bridge from files on the
// box to the ingestion discipline. Proves the loader preserves every control:
// dry-run writes nothing; a non-ingest role is refused (ingest.roles, the same
// registry set the endpoint enforces); same-user maker/checker is refused; and
// --commit drives submit (maker) → approve (checker) into the opening bucket.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const H = require('./helpers');
const db = require('../src/db');
const { runLoad } = require('../scripts/load-ingest');
const { F } = H;

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));

before(H.start);
after(H.stop);

test('load-ingest: dry-run stages nothing; role + same-user guards hold; --commit loads via maker-checker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-'));
  const csv = path.join(dir, 'ob.csv');
  fs.writeFileSync(csv,
    'pf,name,site,accrued,taken,balance\n' +
    '92000001,Load One,North Mara,12,2,10\n' +
    '92000002,Load Two,North Mara,8,3,5\n');
  const ctl = path.join(dir, 'control.json');
  fs.writeFileSync(ctl, JSON.stringify([{ site: 'North Mara', count: 2, sum_balance: 15 }]));
  const base = { kind: 'opening-balance', csvPath: csv, controlPath: ctl };

  // Dry-run (default): preview + exception report only — nothing staged or loaded.
  const prev = await runLoad({ ...base, makerEmail: F.USERS.FINMGR_A.email, checkerEmail: F.USERS.CFC_A.email });
  assert.equal(prev.committed, false);
  assert.equal(prev.clean, 2);
  assert.equal(prev.control_ok, true);
  assert.ok(fs.existsSync(prev.exception_report), 'exception report written even on a dry-run');
  assert.equal((await owner(`SELECT count(*)::int n FROM employee WHERE legacy_id='92000001'`)).rows[0].n, 0, 'dry-run loaded nothing');

  // Guards: same-user maker/checker refused; a non-ingest role refused.
  await assert.rejects(runLoad({ ...base, commit: true,
    makerEmail: F.USERS.FINMGR_A.email, checkerEmail: F.USERS.FINMGR_A.email }), /maker-checker|DIFFERENT/i);
  await assert.rejects(runLoad({ ...base, commit: true,
    makerEmail: F.USERS.HR_A.email, checkerEmail: F.USERS.CFC_A.email }), /ingest\.maker\.roles/);

  // Commit: maker (R11) submits, checker (R12) approves → the opening bucket.
  const res = await runLoad({ ...base, commit: true,
    makerEmail: F.USERS.FINMGR_A.email, checkerEmail: F.USERS.CFC_A.email });
  try {
    assert.equal(res.committed, true);
    assert.equal(res.loaded, 2);
    const e = (await owner(`SELECT id FROM employee WHERE legacy_id='92000001'`)).rows[0];
    assert.ok(e, 'employee created via the app creation path');
    const lc = (await owner(`SELECT days, opening_bucket FROM leave_carry WHERE employee_id=$1`, [e.id])).rows[0];
    assert.equal(Number(lc.days), 10);
    assert.equal(lc.opening_bucket, true, 'landed in the protected opening bucket');
  } finally {
    for (const pf of ['92000001', '92000002']) {
      const e = (await owner(`SELECT id FROM employee WHERE legacy_id=$1`, [pf])).rows[0];
      if (e) {
        await owner(`DELETE FROM leave_carry WHERE employee_id=$1`, [e.id]);
        await owner(`DELETE FROM employee WHERE id=$1`, [e.id]);
      }
    }
    if (res.batch_id) await owner(`DELETE FROM ingest_batch WHERE id=$1`, [res.batch_id]);
  }
});
