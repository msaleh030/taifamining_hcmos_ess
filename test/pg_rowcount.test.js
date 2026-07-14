'use strict';
// Vendored pg client: rowCount from the CommandComplete tag. Writers that
// report what they touched (sync-config, classify-expats) depend on it —
// before this pin the client returned undefined for every write.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers');
const db = require('../src/db');
const { F } = H;

before(H.start);
after(H.stop);

test('vendored client reports rowCount for INSERT/UPDATE/DELETE and conflicts', async () => {
  await db.withOwner(async (c) => {
    const ins = await c.query(
      `INSERT INTO config (company_id, key, value) VALUES ($1,'zz.rowcount.test','1')
       ON CONFLICT (company_id, key) DO NOTHING`, [F.TENANT_A]);
    assert.equal(ins.rowCount, 1, 'fresh insert counts 1');
    const dup = await c.query(
      `INSERT INTO config (company_id, key, value) VALUES ($1,'zz.rowcount.test','1')
       ON CONFLICT (company_id, key) DO NOTHING`, [F.TENANT_A]);
    assert.equal(dup.rowCount, 0, 'conflicting insert counts 0');
    const upd = await c.query(
      `UPDATE config SET value='2' WHERE company_id=$1 AND key='zz.rowcount.test'`, [F.TENANT_A]);
    assert.equal(upd.rowCount, 1, 'update counts 1');
    const sel = await c.query(
      `SELECT value FROM config WHERE company_id=$1 AND key='zz.rowcount.test'`, [F.TENANT_A]);
    assert.equal(sel.rowCount, 1, 'select rowCount matches rows');
    assert.equal(sel.rows.length, 1);
    const del = await c.query(
      `DELETE FROM config WHERE company_id=$1 AND key='zz.rowcount.test'`, [F.TENANT_A]);
    assert.equal(del.rowCount, 1, 'delete counts 1');
  });
});
