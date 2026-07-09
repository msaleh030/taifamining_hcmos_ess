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
// Identity strings (national_id/tin) may arrive with a spreadsheet's text-guard
// leading apostrophe (e.g. '19740225…) — strip it; keep the value otherwise verbatim.
const idstr = (s) => norm(s).replace(/^'/, '');
// A hire-date arrives as an Excel timestamp ("2022-01-13 19:25:45[.ffffff]");
// keep the calendar date for joined_at, drop the time. Returns null if unparseable.
const asDate = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(norm(s)); return m ? m[1] : null; };
const KINDS = ['opening_balance', 'permit', 'employee_master'];

async function siteMap(exec) {
  const r = await exec.query('SELECT id, name FROM site');
  const m = new Map();
  for (const row of r.rows) m.set(norm(row.name).toUpperCase(), row.id);
  return m;
}

// Employees already loaded, keyed by PF = legacy_id (numeric for opening balances,
// legacy master-file IDs for permits). PLACEHOLDER-parameterised — safe for any
// string value (the vendored client can't bind a JS array, but it binds scalars).
// Carries name + site so PF-matches can be identity-VERIFIED, never assumed.
async function existingByPf(exec, pfs) {
  const uniq = [...new Set(pfs.map(norm).filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const ph = uniq.map((_, i) => `$${i + 1}`).join(',');
  const r = await exec.query(`SELECT id, legacy_id, full_name, site_id FROM employee WHERE legacy_id IN (${ph})`, uniq);
  for (const row of r.rows) map.set(row.legacy_id, { id: row.id, full_name: row.full_name, site_id: row.site_id });
  return map;
}
// Name comparison for PF-match verification: case/spacing-insensitive, verbatim
// otherwise — 'Juma  Hamis Mgeni' == 'juma hamis mgeni', but never fuzzy.
const sameName = (a, b) => norm(a).toLowerCase().replace(/\s+/g, ' ') === norm(b).toLowerCase().replace(/\s+/g, ' ');

// ── Opening-balance validation ──────────────────────────────────────────────
function validateOpening(raw, ctx) {
  const pf = norm(raw.pf), name = norm(raw.name), site = norm(raw.site);
  const accrued = num(raw.accrued), taken = num(raw.taken), balance = num(raw.balance);
  const year = Number.isFinite(num(raw.year)) ? num(raw.year) : ctx.openingYear;
  const site_id = ctx.sites.get(site.toUpperCase()) || null;
  const exceptions = [], warnings = [];
  // ATTACH-BY-PF: once the employee master is loaded, a balance whose PF already
  // exists ATTACHES to that real employee record (not a duplicate, not an
  // exception). A PF with no employee still CREATES one (greenfield path), so a
  // balances-only load keeps working. This is what re-attaches the North Mara
  // leave to the master records instead of failing "no employee match".
  const matched = pf && ctx.existing.has(pf) ? ctx.existing.get(pf).id : null;

  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  if (!name) exceptions.push('name missing');
  if (!Number.isFinite(balance)) exceptions.push('balance missing');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  if ([balance, accrued, taken].every(Number.isFinite) && Math.abs(balance - (accrued - taken)) > 0.5)
    exceptions.push('balance != accrued - taken (>0.5d)');
  if (matched) warnings.push('attaching to an existing employee (matched by PF)');
  // A negative opening balance is a VALID deficit (Omid's ruling, 2026-07-09):
  // carried as a negative opening bucket that offsets future accrual, never
  // clamped to zero. It is WARNED (for visibility) not excepted — the
  // internal-consistency check above still catches garbage. Guard the
  // magnitude so an implausibly large deficit is still flagged for review.
  if (Number.isFinite(balance) && balance < 0)
    warnings.push(`negative opening balance ${balance} — carried as a deficit that nets against future accrual (Omid ruling)`);
  if (Number.isFinite(balance) && Math.abs(balance) > ctx.annual)
    warnings.push(`balance ${balance} exceeds annual entitlement ${ctx.annual} (magnitude)`);

  return { pf, site_id, matched_employee: matched,
    normalized: { pf, name, site, site_id, accrued, taken, balance, year },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// ── Employee-master validation ──────────────────────────────────────────────
// Identity-only load that POPULATES the directory (name / position / department /
// site are directory-visible; national_id / tin / bank are confidential, loaded
// behind the pay gate). One-time create keyed on PF: a PF that already exists is
// an exception (never a silent duplicate). Missing national_id / position are a
// completeness punch-list (WARN, load anyway), not a block.
function validateEmployee(raw, ctx) {
  const pf = norm(raw.pf), name = norm(raw.name), site = norm(raw.site);
  const position = norm(raw.position), dept = norm(raw.department || raw.dept);
  const hire_date = asDate(raw.hire_date || raw.joined_at);
  const national_id = idstr(raw.national_id), tin = idstr(raw.tin), bank = norm(raw.bank);
  const site_id = ctx.sites.get(site.toUpperCase()) || null;
  const exceptions = [], warnings = [];

  // ENRICH-BY-PF (identity-verified): a PF that already exists — e.g. the 103
  // North Mara employees an earlier opening-balance load created with identity
  // fields missing — is the SAME person (PF is the authoritative key), so the
  // master ENRICHES that record instead of duplicating or refusing. But only
  // when the identity checks out: a different NAME or a different SITE on the
  // same PF is genuine ambiguity → exception, never an overwrite.
  let matched = null;
  const prior = pf ? ctx.existing.get(pf) : undefined;
  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  else if (prior) {
    if (!sameName(prior.full_name, name))
      exceptions.push(`PF already loaded with a DIFFERENT name ("${prior.full_name}" vs "${name}") — verify identity, refusing to overwrite`);
    else if (site_id && prior.site_id && prior.site_id !== site_id)
      exceptions.push('PF already loaded at a DIFFERENT site — verify, refusing to move');
    else {
      matched = prior.id;
      warnings.push('enriching an existing employee (matched by PF, name verified) — identity fields filled in, leave kept');
    }
  }
  if (!name) exceptions.push('name missing');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  if (norm(raw.hire_date || raw.joined_at) && !hire_date) warnings.push(`unparseable hire_date "${norm(raw.hire_date)}" — loaded without a join date`);
  if (!position) warnings.push('position (job title) missing — completeness punch-list');
  if (!national_id) warnings.push('national_id missing — completeness punch-list');

  // Format/anomaly flags — the row still loads VERBATIM (the value is the
  // source of truth; we flag, we never "fix"), but each anomaly lands on the
  // punch-list so the data owner can verify against the original document.
  if (hire_date && ctx.today && hire_date > ctx.today)
    warnings.push(`hire_date ${hire_date} is in the future — verify`);
  if (tin && !/^\d{9}$/.test(tin))
    warnings.push(`tin format anomaly "${tin}" (TRA TIN is 9 digits) — verify`);
  if (national_id) {
    const digits = national_id.replace(/\D/g, '');
    if (digits.length !== 20)
      warnings.push(`national_id length anomaly (${digits.length} digits; NIDA is 20) — verify`);
    if ((ctx.natCount.get(national_id) || 0) > 1)
      warnings.push('national_id shared by more than one row in this batch — verify identity');
  }
  if (tin && (ctx.tinCount.get(tin) || 0) > 1)
    warnings.push('tin shared by more than one row in this batch — verify identity');

  return { pf, site_id, matched_employee: matched,
    normalized: { pf, name, site, site_id, position, dept, hire_date, national_id, tin, bank },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// ── Permit validation ───────────────────────────────────────────────────────
async function validatePermit(raw, ctx, exec) {
  const pf = norm(raw.pf), name = norm(raw.name), permit = norm(raw.permit || raw.permit_name);
  const expiry = norm(raw.expiry);
  const exceptions = [], warnings = [];
  let matched = pf && ctx.existing.has(pf) ? ctx.existing.get(pf).id : null;
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
// keyed by site name; employee_master: per-site {count} (a headcount check, no
// sum); permit: a single {count}.
function computeControl(kind, cleanRows) {
  if (kind === 'permit') return { ALL: { count: cleanRows.length } };
  const by = {};
  for (const r of cleanRows) {
    const k = norm(r.normalized.site).toUpperCase();
    by[k] = by[k] || { count: 0, sum_balance: 0 };
    by[k].count += 1;
    if (kind === 'opening_balance') by[k].sum_balance = round2(by[k].sum_balance + r.normalized.balance);
  }
  return by;
}

// Normalise a caller's supplied control totals ([{site,count[,sum_balance]}] or
// the permit {count}) into the same shape computeControl produces.
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
  // Batch-wide identity-number counts (employee_master anomaly flags): two rows
  // sharing a NIDA/TIN is a data-quality question for the owner, not a block.
  const natCount = new Map(), tinCount = new Map();
  if (kind === 'employee_master') {
    for (const r of rows) {
      const n = idstr(r.national_id), t = idstr(r.tin);
      if (n) natCount.set(n, (natCount.get(n) || 0) + 1);
      if (t) tinCount.set(t, (tinCount.get(t) || 0) + 1);
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { sites, pfCount, existing, annual, openingYear, natCount, tinCount, today };

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    let res;
    if (kind === 'permit') res = await validatePermit(rows[i], ctx, exec);
    else if (kind === 'employee_master') res = validateEmployee(rows[i], ctx);
    else res = validateOpening(rows[i], ctx);
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

// v1.5 LI-6: role-differentiated maker/checker (SoD on disjoint roles) — the
// endpoint's ingest.roles union gets you in the door; the LEG you may perform is
// decided here. Finance Manager (ingest.maker.roles) submits; the CFC
// (ingest.checker.roles) approves. Same-user-403 still applies on top.
async function requireLegRole(exec, session, key, leg) {
  const set = await cfg.getRoleSet(session.company_id, key, '', exec);
  if (!set.has(session.role_code)) {
    throw new HttpError(403, `${leg} requires a role in ${key} (SoD: maker and checker are disjoint roles)`);
  }
}

// SUBMIT (maker): stage the batch; writes NOTHING to the live owed tables.
async function submit(session, kind, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  return db.withTenant(session.company_id, async (c) => {
    await requireLegRole(c, session, 'ingest.maker.roles', 'submit');
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

// APPROVE (checker): checker role, distinct user, control-totals gate, ATOMIC write.
async function approve(session, kind, body, opts = {}) {
  return db.withTenant(session.company_id, async (c) => {
    await requireLegRole(c, session, 'ingest.checker.roles', 'approve');
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
      if (kind === 'employee_master') {
        let empId = r.matched_employee;
        if (empId) {
          // ENRICH the PF-matched (identity-verified at validation) record: an
          // earlier balances-only load created it with identity fields missing.
          // Site/status/leave are untouched; the master fills in what it owns.
          await c.query(
            `UPDATE employee SET emp_no = coalesce(emp_no, $2), position = $3, dept = $4,
                    joined_at = coalesce($5::date, joined_at)
              WHERE id = $1`,
            [empId, nzd.pf, nzd.position || null, nzd.dept || null, nzd.hire_date]);
        } else {
          // EM: create the employee through the application path (site-scoped,
          // directory-visible). PF is the legacy number AND emp_no.
          empId = await employees.create(c, session.company_id, {
            legacy_id: nzd.pf, emp_no: nzd.pf, full_name: nzd.name, site_id: r.site_id,
            dept: nzd.dept, position: nzd.position, joined_at: nzd.hire_date,
            role_code: 'R01', status: 'active',
          });
        }
        // Confidential identity (national_id / tin / bank) → employee_pay, behind
        // the pay gate. Only write the row when there is something to protect, so
        // "no confidential data" stays "no row" (C5: absent, not null-flagged).
        // Upsert: an enriched employee may already carry a pay row.
        if (nzd.national_id || nzd.tin || nzd.bank) {
          await c.query(
            `INSERT INTO employee_pay (employee_id, company_id, bank_name, national_id, tin)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (employee_id) DO UPDATE
               SET bank_name = coalesce(EXCLUDED.bank_name, employee_pay.bank_name),
                   national_id = coalesce(EXCLUDED.national_id, employee_pay.national_id),
                   tin = coalesce(EXCLUDED.tin, employee_pay.tin)`,
            [empId, session.company_id, nzd.bank || null, nzd.national_id || null, nzd.tin || null]);
        }
      } else if (kind === 'opening_balance') {
        // ATTACH-BY-PF (re-attach leave to the master): if the employee already
        // exists, attach the balance to that real record — idempotently, so a
        // re-run of the same year's opening bucket UPDATES it rather than doubling.
        // No match → create the employee (greenfield balances-only load).
        let empId = r.matched_employee;
        let attached = false;
        if (empId) {
          const upd = await c.query(
            `UPDATE leave_carry SET days=$4, lapsed_at=NULL
              WHERE company_id=$1 AND employee_id=$2 AND opening_bucket=true AND carried_for_year=$3`,
            [session.company_id, empId, nzd.year, nzd.balance]);
          attached = upd.rowCount > 0;
        } else {
          // OB-6: create the employee through the application path (site-scoped).
          empId = await employees.create(c, session.company_id,
            { legacy_id: nzd.pf, full_name: nzd.name, site_id: r.site_id, role_code: 'R01', status: 'active' });
        }
        // OB-5: opening balance → protected opening bucket, exempt from the lapse.
        // (Only INSERT when we did not update an existing same-year bucket.)
        if (!attached) await c.query(
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
