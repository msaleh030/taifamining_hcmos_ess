'use strict';
// Slice 9 — Document expiry alerts (C20b body, DOC-01, DA-1/DA-2). Raises an alert
// when a document is within its DA-1 lead time, to the DA-2 notified role; repeats
// (bumps notify_count) until renewed; clears on renewal. Lead times AND notified
// roles are read from the registry — nothing hard-coded.
const db = require('./db');
const cfg = require('./config');

const ALERTABLE = ['contract', 'permit', 'licence', 'medical'];

// asOf 'YYYY-MM-DD' + n days → 'YYYY-MM-DD' (UTC, no time-zone drift).
function addDaysStr(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function notifyRole(c, companyId, employeeId, role, doc) {
  await c.query(
    `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
     VALUES ($1,$2,'console',$3,'doc.expiry',$4)`,
    [companyId, employeeId, role || 'unassigned',
     { document_id: doc.id, kind: doc.kind, due_date: doc.valid_until }]);
}

// Run the standing expiry sweep as of `asOf` (injected for determinism).
async function runExpiryAlerts(session, asOf) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const lead = {}, role = {};
    for (const k of ALERTABLE) {
      lead[k] = await cfg.getInt(co, `doc.lead_time.${k}`, 30, c);
      role[k] = await cfg.getConfig(co, `doc.notify.role.${k}`, null, c);
    }

    // ALERTABLE is a fixed code constant (no injection surface); inline it — the
    // vendored client can't bind a JS array as a Postgres array param.
    const inList = ALERTABLE.map((k) => `'${k}'`).join(',');
    const docs = (await c.query(
      `SELECT id, employee_id, kind, valid_until::text AS valid_until
         FROM employee_document WHERE kind IN (${inList}) AND valid_until IS NOT NULL`)).rows;

    const raised = [], cleared = [];
    let openCount = 0;
    for (const d of docs) {
      const within = String(d.valid_until).slice(0, 10) <= addDaysStr(asOf, lead[d.kind]);
      const existing = (await c.query(
        'SELECT id, status FROM doc_alert WHERE document_id=$1', [d.id])).rows[0];

      if (within) {
        openCount++;
        if (!existing) {
          const ins = (await c.query(
            `INSERT INTO doc_alert (company_id, document_id, kind, due_date, lead_days, notify_role, status, notify_count, last_notified_at)
             VALUES ($1,$2,$3,$4,$5,$6,'open',1,$7) RETURNING id`,
            [co, d.id, d.kind, d.valid_until, lead[d.kind], role[d.kind], asOf])).rows[0];
          await notifyRole(c, co, d.employee_id, role[d.kind], d);
          raised.push({ alert_id: ins.id, document_id: d.id, kind: d.kind, notify_role: role[d.kind] });
        } else {
          // repeat until renewed (re-open if previously cleared).
          await c.query(
            `UPDATE doc_alert SET status='open', notify_count=notify_count+1, last_notified_at=$2, cleared_at=NULL WHERE id=$1`,
            [existing.id, asOf]);
          await notifyRole(c, co, d.employee_id, role[d.kind], d);
          if (existing.status !== 'open') raised.push({ alert_id: existing.id, document_id: d.id, kind: d.kind, notify_role: role[d.kind], reopened: true });
        }
      } else if (existing && existing.status === 'open') {
        await c.query(`UPDATE doc_alert SET status='cleared', cleared_at=$2 WHERE id=$1`, [existing.id, asOf]);
        cleared.push({ alert_id: existing.id, document_id: d.id, kind: d.kind });
      }
    }
    return { as_of: asOf, raised, cleared, open_count: openCount };
  });
}

module.exports = { runExpiryAlerts };
