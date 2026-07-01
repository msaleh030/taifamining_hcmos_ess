'use strict';
// Opening-Balance & Document Ingestion — same discipline as the Exact publish:
// validate → control-totals → maker-checker → atomic, dry-run first.
//
//   preview  — normalise + validate + compute control totals. Writes NOTHING.
//   commit   — TWO-PHASE maker-checker on one endpoint:
//                • SUBMIT (no batch_id): the MAKER stages the batch (records
//                  submitted_by, persists the clean + exception rows) — writes
//                  NOTHING to the live owed-data tables.
//                • APPROVE (batch_id): a DIFFERENT user (the checker) commits.
//                  The commit HARD-BLOCKS (409) unless the control totals
//                  reconcile, then writes the whole batch ATOMICALLY.
//
// Opening balances land in leave_carry tagged opening_bucket=true (protected,
// exempt from the LR-4 lapse). Employees are created through the application's
// creation path (employees.create), never a raw INSERT, so they are site-scoped
// and directory-visible. Permits load to employee_document.
const db = require('./db');
const cfg = require('./config');
const employees = require('./employees');
const { HttpError } = require('./errors');

const round2 = (x) => Math.round(x * 100) / 100;
const norm = (s) => String(s == null ? '' : s).trim();
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/,/g, '').trim()); return Number.isFinite(n) ? n : NaN; };
const KINDS = ['opening_balance', 'permit'];

async function siteMap(exec) {
  const r = await exec.query('SELECT id, name FROM site');
  const m = new Map();
  for (const row of r.rows) m.set(norm(row.name).toUpperCase(), row.id);
  return m;
}

// Employees already loaded, keyed by PF = legacy_id (numeric for opening balances,
// legacy master-file IDs for permits). PLACEHOLDER-parameterised — safe for any
// string value (the vendored client can't bind a JS array, but it binds scalars).
async function existingByPf(exec, pfs) {
  const uniq = [...new Set(pfs.map(norm).filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const ph = uniq.map((_, i) => `$${i + 1}`).join(',');
  const r = await exec.query(`SELECT id, legacy_id FROM employee WHERE legacy_id IN (${ph})`, uniq);
  for (const row of r.rows) map.set(row.legacy_id, row.id);
  return map;
}

// ── Opening-balance validation ──────────────────────────────────────────────
function validateOpening(raw, ctx) {
  const pf = norm(raw.pf), name = norm(raw.name), site = norm(raw.site);
  const accrued = num(raw.accrued), taken = num(raw.taken), balance = num(raw.balance);
  const year = Number.isFinite(num(raw.year)) ? num(raw.year) : ctx.openingYear;
  const site_id = ctx.sites.get(site.toUpperCase()) || null;
  const exceptions = [], warnings = [];

  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  else if (ctx.existing.has(pf)) exceptions.push('PF already loaded (cross-file duplicate)');
  if (!name) exceptions.push('name missing');
  if (!Number.isFinite(balance)) exceptions.push('balance missing');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  if ([balance, accrued, taken].every(Number.isFinite) && Math.abs(balance - (accrued - taken)) > 0.5)
    exceptions.push('balance != accrued - taken (>0.5d)');
  if (Number.isFinite(balance) && balance < 0) exceptions.push('negative balance');
  if (Number.isFinite(balance) && balance > ctx.annual) warnings.push(`balance ${balance} exceeds annual entitlement ${ctx.annual} (magnitude)`);

  return { pf, site_id, matched_employee: null,
    normalized: { pf, name, site, site_id, accrued, taken, balance, year },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// ── Permit validation ───────────────────────────────────────────────────────
async function validatePermit(raw, ctx, exec) {
  const pf = norm(raw.pf), name = norm(raw.name), permit = norm(raw.permit || raw.permit_name);
  const expiry = norm(raw.expiry);
  const exceptions = [], warnings = [];
  let matched = pf && ctx.existing.has(pf) ? ctx.existing.get(pf) : null;
  let by = matched ? 'pf' : null;
  if (!matched && name) {  // fall back to name match, which needs manual confirm
    const r = await exec.query('SELECT id FROM employee WHERE lower(full_name)=lower($1)', [name]);
    if (r.rows[0]) { matched = r.rows[0].id; by = 'name'; warnings.push('matched by name — manual confirm'); }
  }
  if (!permit) exceptions.push('permit name missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) exceptions.push('expiry required (YYYY-MM-DD)');
  if (!matched) exceptions.push('no employee match (PF or name)');

  return { pf, site_id: null, matched_employee: matched,
    normalized: { pf, name, permit, expiry, matched_by: by },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// Control totals over the CLEAN rows. opening_balance: per-site {count,sum_balance}
// keyed by site name; permit: a single {count}.
function computeControl(kind, cleanRows) {
  if (kind === 'permit') return { ALL: { count: cleanRows.length } };
  const by = {};
  for (const r of cleanRows) {
    const k = norm(r.normalized.site).toUpperCase();
    by[k] = by[k] || { count: 0, sum_balance: 0 };
    by[k].count += 1;
    by[k].sum_balance = round2(by[k].sum_balance + r.normalized.balance);
  }
  return by;
}

// Normalise a caller's supplied control totals ([{site,count,sum_balance}] or the
// permit {count}) into the same shape computeControl produces.
function normSupplied(kind, supplied) {
  if (kind === 'permit') return { ALL: { count: Number((supplied && supplied.count) || 0) } };
  const by = {};
  for (const s of supplied || []) by[norm(s.site).toUpperCase()] = { count: Number(s.count || 0), sum_balance: round2(Number(s.sum_balance || 0)) };
  return by;
}

function reconcile(kind, supplied, computed) {
  const mismatches = [];
  const keys = new Set([...Object.keys(supplied), ...Object.keys(computed)]);
  for (const k of keys) {
    const s = supplied[k], c = computed[k];
    if (!s) { mismatches.push({ site: k, reason: 'not in expected totals', computed: c }); continue; }
    if (!c) { mismatches.push({ site: k, reason: 'no clean rows for expected site', expected: s }); continue; }
    if (s.count !== c.count) mismatches.push({ site: k, field: 'count', expected: s.count, computed: c.count });
    if (kind === 'opening_balance' && round2(s.sum_balance) !== round2(c.sum_balance))
      mismatches.push({ site: k, field: 'sum_balance', expected: s.sum_balance, computed: c.sum_balance });
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Validate a whole batch (shared by preview + submit). Returns per-row results.
async function evaluate(exec, companyId, kind, rows) {
  const sites = await siteMap(exec);
  const pfCount = new Map();
  for (const r of rows) { const p = norm(r.pf); if (p) pfCount.set(p, (pfCount.get(p) || 0) + 1); }
  const existing = await existingByPf(exec, rows.map((r) => norm(r.pf)));
  const annual = await cfg.getInt(companyId, 'leave.entitlement.default', 21, exec);
  const openingYear = 2026;
  const ctx = { sites, pfCount, existing, annual, openingYear };

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const res = kind === 'permit' ? await validatePermit(rows[i], ctx, exec) : validateOpening(rows[i], ctx);
    results.push({ row_no: i + 1, ...res });
  }
  return results;
}

// ── AC OB-1: preview (dry-run) — writes NOTHING ─────────────────────────────
async function preview(session, kind, body = {}) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'unknown ingest kind');
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return db.withTenant(session.company_id, async (c) => {
    const results = await evaluate(c, session.company_id, kind, rows);
    const clean = results.filter((r) => r.status === 'clean');
    const exceptions = results.filter((r) => r.status === 'exception');
    const control = reconcile(kind, normSupplied(kind, body.control_totals), computeControl(kind, clean));
    return { kind, clean_count: clean.length, exception_count: exceptions.length, control,
      clean, exceptions };
  });
}

// ── commit: SUBMIT (no batch_id) or APPROVE (batch_id) ──────────────────────
async function commit(session, kind, body = {}, opts = {}) {
  if (!KINDS.includes(kind)) throw new HttpError(400, 'unknown ingest kind');
  return body.batch_id ? approve(session, kind, body, opts) : submit(session, kind, body);
}

// SUBMIT (maker): stage the batch; writes NOTHING to the live owed tables.
async function submit(session, kind, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return db.withTenant(session.company_id, async (c) => {
    const results = await evaluate(c, session.company_id, kind, rows);
    const clean = results.filter((r) => r.status === 'clean');
    const exceptions = results.filter((r) => r.status === 'exception');
    const control = reconcile(kind, normSupplied(kind, body.control_totals), computeControl(kind, clean));

    const batch = (await c.query(
      `INSERT INTO ingest_batch (company_id, kind, status, submitted_by, control, clean_count, exception_count)
       VALUES ($1,$2,'submitted',$3,$4,$5,$6) RETURNING id`,
      [session.company_id, kind, session.user_id || null, JSON.stringify(normSupplied(kind, body.control_totals)),
       clean.length, exceptions.length])).rows[0];
    for (const r of results) {
      await c.query(
        `INSERT INTO ingest_row (company_id, batch_id, row_no, pf, site_id, normalized, status, exceptions, warnings, matched_employee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [session.company_id, batch.id, r.row_no, r.pf || null, r.site_id || null,
         JSON.stringify(r.normalized), r.status, JSON.stringify(r.exceptions), JSON.stringify(r.warnings), r.matched_employee || null]);
    }
    return { batch_id: batch.id, kind, status: 'submitted',
      clean_count: clean.length, exception_count: exceptions.length, control };
  });
}

// APPROVE (checker): distinct user, control-totals gate, ATOMIC live write.
async function approve(session, kind, body, opts = {}) {
  return db.withTenant(session.company_id, async (c) => {
    const b = (await c.query('SELECT * FROM ingest_batch WHERE id=$1', [body.batch_id])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    if (b.kind !== kind) throw new HttpError(400, 'batch kind mismatch');
    if (b.status !== 'submitted') throw new HttpError(409, `batch is ${b.status}, not submitted`);

    // OB-2 maker-checker: the committer MUST differ from the submitter.
    if (b.submitted_by && session.user_id && String(session.user_id) === String(b.submitted_by))
      throw new HttpError(403, 'maker-checker: the approver must differ from the submitter');

    const cleanRows = (await c.query(
      `SELECT row_no, pf, site_id, normalized, matched_employee FROM ingest_row
        WHERE batch_id=$1 AND status='clean' ORDER BY row_no`, [body.batch_id])).rows;

    // OB-3 control-totals gate: HARD-BLOCK (409) unless the clean set reconciles
    // with the totals the maker submitted. Checked BEFORE any write.
    const control = reconcile(kind, b.control, computeControl(kind, cleanRows));
    if (!control.ok) throw new HttpError(409, 'control totals do not reconcile', { mismatches: control.mismatches });

    // OB-4 atomic: the whole batch commits or none of it (this is one tenant tx;
    // an injected mid-batch fault throws and rolls everything back).
    let loaded = 0;
    for (let i = 0; i < cleanRows.length; i++) {
      const r = cleanRows[i];
      const nzd = r.normalized;
      if (opts.faultStep === 'mid_batch' && i === 1) throw new Error('injected fault (test)');
      if (kind === 'opening_balance') {
        // OB-6: create the employee through the application path (site-scoped).
        const empId = await employees.create(c, session.company_id,
          { legacy_id: r.pf, full_name: nzd.name, site_id: r.site_id, role_code: 'R01', status: 'active' });
        // OB-5: opening balance → protected opening bucket, exempt from the lapse.
        await c.query(
          `INSERT INTO leave_carry (company_id, employee_id, days, carried_for_year, opening_bucket)
           VALUES ($1,$2,$3,$4,true)`, [session.company_id, empId, nzd.balance, nzd.year]);
      } else {
        await c.query(
          `INSERT INTO employee_document (company_id, employee_id, kind, name, valid_until)
           VALUES ($1,$2,'permit',$3,$4)`, [session.company_id, r.matched_employee, nzd.permit, nzd.expiry]);
      }
      loaded += 1;
    }
    await c.query(`UPDATE ingest_batch SET status='committed', committed_by=$2, committed_at=now() WHERE id=$1`,
      [body.batch_id, session.user_id || null]);
    return { batch_id: body.batch_id, kind, status: 'committed', loaded };
  });
}

// ── AC OB-7: the exception report — downloadable and complete ───────────────
async function exceptionReport(session, batchId) {
  return db.withTenant(session.company_id, async (c) => {
    const b = (await c.query('SELECT kind, status FROM ingest_batch WHERE id=$1', [batchId])).rows[0];
    if (!b) throw new HttpError(404, 'batch not found');
    const rows = (await c.query(
      `SELECT row_no, pf, normalized, exceptions FROM ingest_row
        WHERE batch_id=$1 AND status='exception' ORDER BY row_no`, [batchId])).rows;
    return { batch_id: batchId, kind: b.kind, count: rows.length,
      exceptions: rows.map((r) => ({ row_no: r.row_no, pf: r.pf, reasons: r.exceptions, row: r.normalized })) };
  });
}

module.exports = { preview, commit, submit, approve, exceptionReport };
