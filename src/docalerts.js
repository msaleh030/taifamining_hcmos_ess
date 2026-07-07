'use strict';
// Slice 9 — Document expiry alerts (C20b body, DOC-01, DA-1/DA-2). Raises an alert
// when a document is within its DA-1 lead time, to the DA-2 notified role; repeats
// (bumps notify_count) until renewed; clears on renewal. Lead times AND notified
// roles are read from the registry — nothing hard-coded.
//
// DA-2 split (Kira, ratified 2026-07-06; contract split added later same day):
//   • expat/immigration permit expiries → Head of HR (R11) ONLY — sensitive;
//     visibility AND notification are scoped to R11 alone, never the SHEQ Manager.
//   • business permit / licence expiries → SHEQ Manager (R06) — unchanged leg.
//   • medical-document expiries → the HR Officer (R03) FOR THE EMPLOYEE'S SITE —
//     the site-scoped R03 matching the employee's site, NOT all HR Officers.
//   • contract expiries key off employee.is_expat (the CSV-driven flag):
//     expat → R11 ONLY (as sensitive as their permit); local → the SITE-MATCHED
//     R03. Never the SHEQ Manager (supersedes the R06 inference).
// A permit whose expat-vs-business classification is missing is NEVER guessed:
// it FAILS CLOSED to the sensitive leg (R11-only) and carries `unclassified`
// until someone who knows sets employee_document.permit_type
// (scripts/classify-expats.js applies the authoritative client list).
const db = require('./db');
const cfg = require('./config');
const sitescope = require('./sitescope');

const ALERTABLE = ['contract', 'permit', 'licence', 'medical'];

// asOf 'YYYY-MM-DD' + n days → 'YYYY-MM-DD' (UTC, no time-zone drift).
function addDaysStr(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Resolve the DA-2 route for one document: { role, site, unclassified }.
// `site` is non-null only for the site-matched legs (medical, local contract).
function routeFor(roles, d) {
  if (d.kind === 'permit') {
    if (d.permit_type === 'business') return { role: roles.permitBusiness, site: null, unclassified: false };
    if (d.permit_type === 'expat') return { role: roles.permitExpat, site: null, unclassified: false };
    // Unclassified permit — fail CLOSED to the sensitive leg, flagged.
    return { role: roles.permitExpat, site: null, unclassified: true };
  }
  if (d.kind === 'medical') return { role: roles.medical, site: d.site_id, unclassified: false };
  if (d.kind === 'contract') {
    // employee.is_expat is deterministic (default false = local, per Kira:
    // everyone not on the authoritative list is local) — no unclassified leg.
    return d.is_expat
      ? { role: roles.contractExpat, site: null, unclassified: false }
      : { role: roles.contractLocal, site: d.site_id, unclassified: false };
  }
  return { role: roles[d.kind], site: null, unclassified: false };
}

async function notifyRoute(c, companyId, employeeId, route, doc) {
  await c.query(
    `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
     VALUES ($1,$2,'console',$3,'doc.expiry',$4)`,
    [companyId, employeeId, route.role || 'unassigned',
     { document_id: doc.id, kind: doc.kind, due_date: doc.valid_until,
       ...(route.site ? { site_id: route.site } : {}),
       ...(route.unclassified ? { unclassified: true } : {}) }]);
}

// Run the standing expiry sweep as of `asOf` (injected for determinism).
async function runExpiryAlerts(session, asOf) {
  const co = session.company_id;
  return db.withTenant(co, async (c) => {
    const lead = {};
    for (const k of ALERTABLE) lead[k] = await cfg.getInt(co, `doc.lead_time.${k}`, 30, c);
    const roles = {
      contractExpat: await cfg.getConfig(co, 'doc.notify.role.contract.expat', null, c),
      contractLocal: await cfg.getConfig(co, 'doc.notify.role.contract.local', null, c),
      permitExpat: await cfg.getConfig(co, 'doc.notify.role.permit.expat', null, c),
      permitBusiness: await cfg.getConfig(co, 'doc.notify.role.permit.business', null, c),
      licence: await cfg.getConfig(co, 'doc.notify.role.licence', null, c),
      medical: await cfg.getConfig(co, 'doc.notify.role.medical', null, c),
    };

    // ALERTABLE is a fixed code constant (no injection surface); inline it — the
    // vendored client can't bind a JS array as a Postgres array param. The join
    // carries the employee's site for the site-matched medical leg.
    const inList = ALERTABLE.map((k) => `'${k}'`).join(',');
    const docs = (await c.query(
      `SELECT d.id, d.employee_id, d.kind, d.permit_type, d.valid_until::text AS valid_until,
              e.site_id, e.is_expat
         FROM employee_document d JOIN employee e ON e.id = d.employee_id
        WHERE d.kind IN (${inList}) AND d.valid_until IS NOT NULL`)).rows;

    const raised = [], cleared = [];
    let openCount = 0, unclassifiedCount = 0;
    for (const d of docs) {
      const within = String(d.valid_until).slice(0, 10) <= addDaysStr(asOf, lead[d.kind]);
      const existing = (await c.query(
        'SELECT id, status, last_notified_at::text AS last_notified_at FROM doc_alert WHERE document_id=$1', [d.id])).rows[0];

      if (within) {
        openCount++;
        const route = routeFor(roles, d);
        if (route.unclassified) unclassifiedCount++;
        // Idempotent per asOf: a re-fire of the SAME sweep date must not
        // re-notify or inflate notify_count. Skip a still-open alert already
        // notified as of this date (the re-open-from-cleared path still runs).
        if (existing && existing.status === 'open'
            && String(existing.last_notified_at).slice(0, 10) === String(asOf).slice(0, 10)) {
          continue;
        }
        if (!existing) {
          const ins = (await c.query(
            `INSERT INTO doc_alert (company_id, document_id, kind, due_date, lead_days, notify_role, notify_site, unclassified, status, notify_count, last_notified_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',1,$9) RETURNING id`,
            [co, d.id, d.kind, d.valid_until, lead[d.kind], route.role, route.site, route.unclassified, asOf])).rows[0];
          await notifyRoute(c, co, d.employee_id, route, d);
          raised.push({ alert_id: ins.id, document_id: d.id, kind: d.kind, notify_role: route.role, notify_site: route.site, unclassified: route.unclassified });
        } else {
          // Repeat until renewed (re-open if previously cleared). The route is
          // re-resolved every sweep so a registry flip or a late expat/business
          // classification re-routes the standing alert — no deploy needed.
          await c.query(
            `UPDATE doc_alert SET status='open', notify_count=notify_count+1, last_notified_at=$2,
                    cleared_at=NULL, notify_role=$3, notify_site=$4, unclassified=$5 WHERE id=$1`,
            [existing.id, asOf, route.role, route.site, route.unclassified]);
          await notifyRoute(c, co, d.employee_id, route, d);
          if (existing.status !== 'open') raised.push({ alert_id: existing.id, document_id: d.id, kind: d.kind, notify_role: route.role, notify_site: route.site, unclassified: route.unclassified, reopened: true });
        }
      } else if (existing && existing.status === 'open') {
        await c.query(`UPDATE doc_alert SET status='cleared', cleared_at=$2 WHERE id=$1`, [existing.id, asOf]);
        cleared.push({ alert_id: existing.id, document_id: d.id, kind: d.kind });
      }
    }
    return { as_of: asOf, raised, cleared, open_count: openCount, unclassified_count: unclassifiedCount };
  });
}

// The current open document-expiry alerts (the alerts dashboard, read-only).
// Row-level DA-2 visibility (Kira, 2026-07-06) applies ON TOP of the
// alerts.view.roles module gate the route already enforced:
//   • expat permits — and unclassified permits, which fail closed — are
//     visible to the routed role ONLY (R11; not even the admin sees them);
//   • medical alerts and LOCAL contract alerts are visible only to the routed
//     role whose own site matches the employee's (the site-matched R03);
//   • EXPAT contract alerts mirror expat permits — routed role (R11) only;
//   • licence + business permit are unchanged — any alerts.view.roles member.
async function listOpen(session) {
  return db.withTenant(session.company_id, async (c) => {
    const rows = (await c.query(
      `SELECT a.id, a.document_id, a.kind, a.due_date::text AS due_date, a.notify_role,
              a.notify_site, a.unclassified, a.status, a.notify_count, d.permit_type
         FROM doc_alert a JOIN employee_document d ON d.id = a.document_id
        WHERE a.status='open' ORDER BY a.due_date`)).rows;
    const role = session.role_code;
    const mySite = await sitescope.requesterSite(c, session);
    const open = rows.filter((r) => {
      if (r.kind === 'permit' && (r.unclassified || r.permit_type === 'expat')) return role === r.notify_role;
      if (r.kind === 'medical' || r.kind === 'contract') {
        // The SITE-LESS branch is reserved for the genuinely site-less sensitive
        // leg: the EXPAT CONTRACT, routed to R11 (notify_role='R11'). For the
        // site-matched legs (medical + LOCAL contract, routed to the site R03),
        // a null notify_site is a data gap (employee with no site) — it must
        // FAIL CLOSED, not fan out to every HR Officer in the tenant.
        if (r.notify_site == null) return role === r.notify_role && role === 'R11';
        return role === r.notify_role && mySite != null && r.notify_site === mySite;
      }
      return true;
    });
    return { open };
  });
}

module.exports = { runExpiryAlerts, listOpen };
