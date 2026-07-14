'use strict';
// Slice 4 — Disciplinary action + atomic fan-out (C8).
//
// A single CONFIRMED action (issued by a permitted issuer, approved by a distinct
// permitted checker) fans out in ONE transaction: register entry, ESS
// notification to the employee, console notification naming the resolved line
// manager + HR, an auto-generated warning letter in My Documents, an activity-feed
// entry, and an audit entry — plus a lifecycle flip for suspensions. Because the
// whole fan-out runs inside a single withTenant transaction, any failure rolls
// back everything (no partial register entry, no orphan notification).
//
// SoD is server-enforced from the registry and holds even on a direct call.
const db = require('./db');
const cfg = require('./config');
const sitescope = require('./sitescope');
const { HttpError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);
const ACTION_TYPES = new Set(['verbal', 'written', 'final', 'suspension']);

async function resolveUser(client, userId) {
  const r = await client.query(
    'SELECT id, role_code, email, employee_id FROM app_user WHERE id=$1', [userId]);
  return r.rows[0] || null;
}

// Issue and fan out a confirmed disciplinary action.
//   issuer            — the acting session { company_id, user_id, role_code }
//   input.employeeId  — subject
//   input.actionType  — verbal | written | final | suspension
//   input.detail      — free text
//   input.approverUserId — the distinct checker who confirmed the action
// opts.faultStep (TEST ONLY) forces a throw at a named step to prove atomicity.
async function issueAction(issuer, input = {}, opts = {}) {
  const { employeeId, actionType, detail, approverUserId } = input;
  if (!issuer || !issuer.company_id || !issuer.user_id) throw new HttpError(401, 'authentication required');
  if (!isUuid(employeeId)) throw new HttpError(400, 'invalid employee');
  if (!ACTION_TYPES.has(actionType)) throw new HttpError(400, 'invalid action type');
  if (!isUuid(approverUserId)) throw new HttpError(400, 'approver required');

  const company = issuer.company_id;
  const issuerRoles  = await cfg.getRoleSet(company, 'disciplinary.issuer.roles', 'R02,R06');
  const checkerRoles = await cfg.getRoleSet(company, 'disciplinary.checker.roles', 'R04,R11');
  const hrRole       = await cfg.getConfig(company, 'disciplinary.hr.role', 'R04');

  // Issuer permission (server-side; UI never the control).
  if (!issuerRoles.has(issuer.role_code)) throw new HttpError(403, 'issuer not permitted');

  return db.withTenant(company, async (c) => {
    const subj = (await c.query(
      'SELECT id, site_id, status, full_name FROM employee WHERE id=$1', [employeeId])).rows[0];
    if (!subj) throw new HttpError(404, 'employee not found');

    // Site scope: a site-bound issuer (e.g. R02/R06) may only act on — and by
    // loading full_name/site_id, read — employees at their OWN site. Same 404
    // the directory gives for an out-of-site id (Section 17.2).
    if (await sitescope.isScoped(c, issuer.role_code)) {
      const mySites = await sitescope.requesterSites(c, issuer);
      if (!mySites.length || !mySites.includes(subj.site_id)) throw new HttpError(404, 'employee not found');
    }

    const issuerU  = await resolveUser(c, issuer.user_id);
    if (!issuerU) throw new HttpError(403, 'unknown issuer');
    const approver = await resolveUser(c, approverUserId);
    if (!approver) throw new HttpError(404, 'approver not found');

    // ── Separation of duties (registry matrix, enforced here) ───────────────
    if (!checkerRoles.has(approver.role_code)) throw new HttpError(403, 'approver not permitted');
    if (issuerU.employee_id === subj.id)         throw new HttpError(403, 'cannot act on self');
    if (approver.employee_id === subj.id)        throw new HttpError(403, 'approver cannot be the subject');
    if (approver.employee_id === issuerU.employee_id) throw new HttpError(403, 'issuer and checker must differ');

    // Manager resolved from the subject's site.
    const site = (await c.query(
      `SELECT s.name, s.manager_employee_id, m.full_name AS manager_name
         FROM site s LEFT JOIN employee m ON m.id = s.manager_employee_id WHERE s.id=$1`,
      [subj.site_id])).rows[0] || {};
    const managerName = site.manager_name || null;

    // ── FAN-OUT (atomic) ────────────────────────────────────────────────────
    // 1. disciplinary register entry
    const reg = (await c.query(
      `INSERT INTO disciplinary
         (company_id, employee_id, kind, action_type, detail, issued_by, issuer_role,
          approver, approver_role, manager_employee_id, manager_name)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [company, subj.id, actionType, detail || null, issuerU.email, issuer.role_code,
       approver.email, approver.role_code, site.manager_employee_id || null, managerName])).rows[0];
    if (opts.faultStep === 'after_register') throw new Error('injected fault (test)');

    // 2. ESS notification to the employee
    await c.query(
      `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
       VALUES ($1,$2,'ess',$3,'disciplinary.action',$4)`,
      [company, subj.id, subj.full_name,
       { action_type: actionType, detail: detail || null, ref: reg.id }]);
    if (opts.faultStep === 'after_ess') throw new Error('injected fault (test)');

    // 3. console notification naming the resolved line manager + HR
    await c.query(
      `INSERT INTO notification (company_id, employee_id, audience, recipient, kind, body)
       VALUES ($1,$2,'console',$3,'disciplinary.action',$4)`,
      [company, subj.id, `${managerName || 'line manager'} + HR`,
       { line_manager: managerName, hr_role: hrRole, hr: approver.email,
         action_type: actionType, subject: subj.full_name, ref: reg.id }]);
    if (opts.faultStep === 'after_console') throw new Error('injected fault (test)');

    // 4. auto-generated warning letter into My Documents
    await c.query(
      `INSERT INTO employee_document (company_id, employee_id, kind, name, uri)
       VALUES ($1,$2,'warning',$3,$4)`,
      [company, subj.id, `Warning letter — ${actionType}`, `generated://disciplinary/${reg.id}.pdf`]);
    if (opts.faultStep === 'after_letter') throw new Error('injected fault (test)');

    // 5. activity-feed entry
    await c.query(
      `INSERT INTO activity_feed (company_id, employee_id, actor, kind, summary)
       VALUES ($1,$2,$3,'disciplinary.action',$4)`,
      [company, subj.id, issuerU.email,
       `${actionType} issued by ${issuer.role_code}, approved by ${approver.role_code}`]);

    // 6. suspension → flip lifecycle status AND the login state (app-wide), audited
    if (actionType === 'suspension') {
      await c.query(`UPDATE employee SET status='suspended' WHERE id=$1`, [subj.id]);
      await c.query(`UPDATE app_user SET status='suspended' WHERE employee_id=$1 AND status='active'`, [subj.id]);
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        company, issuerU.email, issuer.role_code, 'employee.status.suspend',
        'employee', subj.id, { status: subj.status }, { status: 'suspended' }]);
    }

    // 7. audit the fan-out as one linked event
    await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      company, issuerU.email, issuer.role_code, 'disciplinary.action.issue',
      'disciplinary', reg.id, null,
      { action_type: actionType, subject: subj.id, manager: managerName,
        approver: approver.email, approver_role: approver.role_code }]);

    return {
      ok: true, id: reg.id, action_type: actionType, subject: subj.id,
      manager: managerName, approver: approver.email, suspended: actionType === 'suspension',
    };
  });
}

module.exports = { issueAction, ACTION_TYPES };
