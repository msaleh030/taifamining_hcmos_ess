'use strict';
// Wave 6 (2026-07-14): the expiry-alert SCHEDULER. The routing/idempotency
// engine (docalerts.runExpiryAlerts) is already pinned elsewhere; this pins the
// net-new tenant-loop entrypoint that the systemd timer drives — that a daily
// sweep raises the R11-only expat-permit alert, fails an unclassified permit
// CLOSED to R11, and is idempotent for a given day.
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const F = require('./fixtures');
const db = require('../src/db');
const { sweepAllTenants } = require('../scripts/run-expiry-alerts');

const owner = (sql, p) => db.withOwner((c) => c.query(sql, p));
test.before(async () => { await H.start(); });
test.after(async () => { await H.stop(); });

const XEMP = 'a0000000-0000-0000-0000-00000000e6c1';
const AS_OF = '2026-07-14';
const WITHIN = '2026-07-24'; // asOf + 10d — inside the 60-day permit lead

async function seed(permitType) {
  await owner(
    `INSERT INTO employee (id, company_id, site_id, full_name, role_code, status, is_expat)
     VALUES ($1,$2,$3,'Zz W6 Expat','R01','active',true)`, [XEMP, F.TENANT_A, F.SITE.A1]);
  await owner(
    `INSERT INTO employee_document (company_id, employee_id, kind, name, valid_until, permit_type)
     VALUES ($1,$2,'permit','Zz Work Permit',$3,$4)`, [F.TENANT_A, XEMP, WITHIN, permitType]);
}
async function cleanup() {
  await owner(`DELETE FROM doc_alert WHERE document_id IN (SELECT id FROM employee_document WHERE employee_id=$1)`, [XEMP]);
  await owner(`DELETE FROM notification WHERE employee_id=$1`, [XEMP]);
  await owner(`DELETE FROM employee_document WHERE employee_id=$1`, [XEMP]);
  await owner(`DELETE FROM employee WHERE id=$1`, [XEMP]);
}
const alertFor = async () => (await owner(
  `SELECT a.notify_role, a.notify_site, a.unclassified, a.status, a.notify_count
     FROM doc_alert a JOIN employee_document d ON d.id=a.document_id
    WHERE d.employee_id=$1`, [XEMP])).rows[0];

test('scheduler sweep raises the R11-only expat-permit alert; second same-day run is idempotent', async () => {
  await seed('expat');
  try {
    await sweepAllTenants(AS_OF);
    let a = await alertFor();
    assert.ok(a, 'the daily sweep raised an alert for the expiring expat permit');
    assert.equal(a.notify_role, 'R11', 'expat permit routes to the Head of HR (R11) only');
    assert.equal(a.unclassified, false);
    assert.equal(a.notify_site, null, 'the sensitive expat leg is site-less');
    assert.equal(a.status, 'open');
    assert.equal(a.notify_count, 1);

    // A second sweep for the SAME day must not re-notify or inflate the count.
    await sweepAllTenants(AS_OF);
    a = await alertFor();
    assert.equal(a.notify_count, 1, 'same-day re-run is a no-op (idempotent scheduler)');
  } finally { await cleanup(); }
});

test('scheduler fails an UNCLASSIFIED permit CLOSED to R11 (never guessed as business)', async () => {
  await seed(null); // permit_type unset — classification unknown
  try {
    await sweepAllTenants(AS_OF);
    const a = await alertFor();
    assert.ok(a, 'an unclassified expiring permit still raises an alert');
    assert.equal(a.notify_role, 'R11', 'unclassified permit fails CLOSED to the sensitive leg');
    assert.equal(a.unclassified, true, 'and is flagged unclassified until someone classifies it');
  } finally { await cleanup(); }
});
