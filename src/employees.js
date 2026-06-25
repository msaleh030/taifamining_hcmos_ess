'use strict';
// Slice 2 — Employee Master service (directory + profile + maker-checker).
// Tenant isolation is RLS (withTenant pins app.company_id). Site-scope and A3
// confidentiality are ADDITIONAL server checks layered on top — never a
// substitute for RLS.
const db = require('./db');
const cfg = require('./config');
const a3 = require('./a3');
const { HttpError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// Fields a maker may propose a change to (whitelist → safe to interpolate).
const EDITABLE_FIELDS = new Set(['phone', 'email', 'dept', 'home_address', 'full_name']);

// Directory list columns (non-confidential).
const LIST_COLS = 'id, emp_no, full_name, role_code, site_id, dept, status, phone, email';

async function directoryDenied(companyId, role) {
  const deny = await cfg.getRoleSet(companyId, 'directory.deny.roles', 'R08,R09,R12,R13');
  return deny.has(role);
}

async function isScoped(client, role) {
  const r = await client.query('SELECT scoped FROM site_scope WHERE role_code=$1', [role]);
  if (r.rows[0]) return r.rows[0].scoped === true;
  return cfg.SITE_SCOPE[role] === true; // fallback to seeded defaults
}

// The viewer's own site, resolved from their employee record (RLS-scoped).
async function requesterSite(client, session) {
  if (!session.user_id) return null;
  const r = await client.query(
    'SELECT e.site_id FROM app_user u JOIN employee e ON e.id = u.employee_id WHERE u.id=$1',
    [session.user_id]);
  return r.rows[0] ? r.rows[0].site_id : null;
}

async function actorEmail(client, session) {
  if (!session.user_id) return null;
  const r = await client.query('SELECT email FROM app_user WHERE id=$1', [session.user_id]);
  return r.rows[0] ? r.rows[0].email : null;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.full_name, row.id]), 'utf8').toString('base64url');
}
function decodeCursor(c) {
  try {
    const [name, id] = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (typeof name === 'string' && isUuid(id)) return { name, id };
  } catch { /* ignore */ }
  throw new HttpError(400, 'invalid cursor');
}

// ── EMP-02 / UNI-02: directory list, keyset-paginated, site-scoped ─────────
async function list(session, params = {}) {
  if (await directoryDenied(session.company_id, session.role_code)) throw new HttpError(403, 'forbidden');

  const pageSize = await cfg.getInt(session.company_id, 'employees.page_size', 50);
  const pageMax = await cfg.getInt(session.company_id, 'employees.page_max', 200);
  let limit = parseInt(params.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = pageSize;
  limit = Math.min(limit, pageMax);

  return db.withTenant(session.company_id, async (client) => {
    const scoped = await isScoped(client, session.role_code);
    let forcedSite = null;
    if (scoped) {
      forcedSite = await requesterSite(client, session);
      // A scoped viewer with no site sees nothing (fail safe, not fail open).
      if (!forcedSite) return { rows: [], next_cursor: null, page_size: limit };
    }

    const where = ['TRUE'];
    const args = [];
    const add = (v) => { args.push(v); return `$${args.length}`; };

    // Site filter is forced for scoped roles (in SQL, not after fetch).
    if (forcedSite) where.push(`site_id = ${add(forcedSite)}`);
    else if (params.site && isUuid(params.site)) where.push(`site_id = ${add(params.site)}`);

    if (params.status) where.push(`status = ${add(params.status)}`);
    if (params.dept) where.push(`dept = ${add(params.dept)}`);
    if (params.q) {
      const p = add(`%${params.q}%`);
      where.push(`(full_name ILIKE ${p} OR emp_no ILIKE ${p})`);
    }
    if (params.cursor) {
      const cur = decodeCursor(params.cursor);
      where.push(`(full_name, id) > (${add(cur.name)}::text, ${add(cur.id)}::uuid)`);
    }

    const sql = `SELECT ${LIST_COLS} FROM employee
                  WHERE ${where.join(' AND ')}
                  ORDER BY full_name, id
                  LIMIT ${add(limit + 1)}`;
    const r = await client.query(sql, args);

    const hasMore = r.rows.length > limit;
    const rows = hasMore ? r.rows.slice(0, limit) : r.rows;
    return {
      rows,
      page_size: limit,
      next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]) : null,
    };
  });
}

// ── EMP-01 / SOD-03 / A3: single profile ───────────────────────────────────
async function get(session, id) {
  if (!isUuid(id)) throw new HttpError(400, 'invalid id');
  if (await directoryDenied(session.company_id, session.role_code)) throw new HttpError(403, 'forbidden');

  return db.withTenant(session.company_id, async (client) => {
    const r = await client.query('SELECT * FROM employee WHERE id=$1', [id]);
    const emp = r.rows[0];
    if (!emp) throw new HttpError(404, 'not found'); // RLS already hid other tenants

    // Site check FIRST — an out-of-site request must 404 before any confidential
    // table is touched (Section 17.2).
    if (await isScoped(client, session.role_code)) {
      const mySite = await requesterSite(client, session);
      if (!mySite || emp.site_id !== mySite) throw new HttpError(404, 'not found');
    }
    return a3.assembleProfile(client, session, emp);
  });
}

// Resolve permitted makers/checkers for a field (field-specific, else generic).
async function rolesFor(companyId, kind, field) {
  let s = await cfg.getRoleSet(companyId, `field_change.${kind}.${field}`, '');
  if (s.size === 0) s = await cfg.getRoleSet(companyId, `field_change.${kind}`,
    kind === 'makers' ? 'R02,R03,R04' : 'R03,R04,R11');
  return s;
}

// ── EMP-03 / UNI-06: submit a change → pending (employee NOT mutated) ───────
async function submitChange(session, id, body) {
  if (!isUuid(id)) throw new HttpError(400, 'invalid id');
  if (await directoryDenied(session.company_id, session.role_code)) throw new HttpError(403, 'forbidden');
  const field = body && body.field;
  if (!EDITABLE_FIELDS.has(field)) throw new HttpError(400, 'field not editable');
  const makers = await rolesFor(session.company_id, 'makers', field);
  if (!makers.has(session.role_code)) throw new HttpError(403, 'forbidden');

  return db.withTenant(session.company_id, async (client) => {
    const r = await client.query(`SELECT id, site_id, "${field}" AS current FROM employee WHERE id=$1`, [id]);
    const emp = r.rows[0];
    if (!emp) throw new HttpError(404, 'not found');
    if (await isScoped(client, session.role_code)) {
      const mySite = await requesterSite(client, session);
      if (!mySite || emp.site_id !== mySite) throw new HttpError(404, 'not found');
    }

    const maker = await actorEmail(client, session);
    if (!maker) throw new HttpError(403, 'forbidden');

    // Offline edits queue with an idempotency key; dedupe on sync.
    const key = body.idempotency_key;
    if (key) {
      const seen = await client.query('SELECT response FROM idempotency WHERE company_id=$1 AND key=$2',
        [session.company_id, key]);
      if (seen.rows[0]) return seen.rows[0].response;
    }

    const before = emp.current == null ? null : String(emp.current);
    const after = body.value == null ? null : String(body.value);
    const ins = await client.query(
      `INSERT INTO field_change(company_id, employee_id, field, before, after, maker, maker_role, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       RETURNING id, field, before, after, status`,
      [session.company_id, id, field, before, after, maker, session.role_code]);
    const rec = ins.rows[0];

    await client.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      session.company_id, maker, session.role_code, 'employee.change.submit',
      'field_change', rec.id, { field, value: before }, { field, value: after }]);

    const response = { ...rec, employee_id: id, pending: true };
    if (key) {
      await client.query('INSERT INTO idempotency(company_id, key, response) VALUES ($1,$2,$3)',
        [session.company_id, key, response]);
    }
    return response;
  });
}

// ── EMP-03 / SOD-03 / UNI-06: approve or decline ───────────────────────────
async function decide(session, changeId, approve) {
  if (!isUuid(changeId)) throw new HttpError(400, 'invalid id');
  if (await directoryDenied(session.company_id, session.role_code)) throw new HttpError(403, 'forbidden');

  return db.withTenant(session.company_id, async (client) => {
    const r = await client.query('SELECT * FROM field_change WHERE id=$1', [changeId]);
    const fc = r.rows[0];
    if (!fc) throw new HttpError(404, 'not found');
    if (fc.status !== 'pending') throw new HttpError(409, 'already decided');
    if (!EDITABLE_FIELDS.has(fc.field)) throw new HttpError(400, 'field not editable');

    const checkers = await rolesFor(session.company_id, 'checkers', fc.field);
    if (!checkers.has(session.role_code)) throw new HttpError(403, 'forbidden');

    const checker = await actorEmail(client, session);
    if (!checker) throw new HttpError(403, 'forbidden');
    // Separation of duties: the checker must not be the maker.
    if (approve && checker === fc.maker) throw new HttpError(403, 'maker cannot be their own checker');

    if (approve) {
      await client.query(`UPDATE employee SET "${fc.field}" = $1 WHERE id=$2`, [fc.after, fc.employee_id]);
      await client.query(
        `UPDATE field_change SET status='approved', checker=$1, decided_at=now() WHERE id=$2`,
        [checker, changeId]);
      await client.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        session.company_id, checker, session.role_code, 'employee.change.approve',
        'field_change', changeId, { field: fc.field, value: fc.before }, { field: fc.field, value: fc.after }]);
      return { id: changeId, field: fc.field, status: 'approved', applied: true };
    }

    await client.query(
      `UPDATE field_change SET status='declined', checker=$1, decided_at=now() WHERE id=$2`,
      [checker, changeId]);
    await client.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
      session.company_id, checker, session.role_code, 'employee.change.decline',
      'field_change', changeId, { field: fc.field, value: fc.before }, { field: fc.field, value: fc.after }]);
    return { id: changeId, field: fc.field, status: 'declined', applied: false };
  });
}

// ── DOC / A3: documents — contract visible to directory roles; medical/permit
//    docs follow the medical A3 set ───────────────────────────────────────────
async function documents(session, id) {
  if (!isUuid(id)) throw new HttpError(400, 'invalid id');
  if (await directoryDenied(session.company_id, session.role_code)) throw new HttpError(403, 'forbidden');

  return db.withTenant(session.company_id, async (client) => {
    const r = await client.query('SELECT id, site_id FROM employee WHERE id=$1', [id]);
    const emp = r.rows[0];
    if (!emp) throw new HttpError(404, 'not found');
    if (await isScoped(client, session.role_code)) {
      const mySite = await requesterSite(client, session);
      if (!mySite || emp.site_id !== mySite) throw new HttpError(404, 'not found');
    }
    const medSet = await cfg.getRoleSet(session.company_id, 'a3.medical.roles', 'R05,R06,R10');
    const canMedical = medSet.has(session.role_code);
    const sql = canMedical
      ? `SELECT id, kind, name, valid_until, uri FROM employee_document WHERE employee_id=$1 ORDER BY kind, name`
      : `SELECT id, kind, name, valid_until, uri FROM employee_document
          WHERE employee_id=$1 AND kind NOT IN ('medical','permit') ORDER BY kind, name`;
    const docs = await client.query(sql, [id]);
    return { documents: docs.rows };
  });
}

module.exports = { list, get, submitChange, decide, documents, EDITABLE_FIELDS };
