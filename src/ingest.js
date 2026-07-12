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
const KINDS = ['opening_balance', 'permit', 'employee_master', 'payroll_master'];

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
// PF uniqueness is SITE-LEVEL (Kira ruling 2026-07-12): the same PF may exist
// at several sites as different people, so each key maps to an ARRAY of rows.
async function existingByPf(exec, pfs) {
  const uniq = [...new Set(pfs.map(norm).filter(Boolean))];
  const map = new Map();
  if (!uniq.length) return map;
  const ph = uniq.map((_, i) => `$${i + 1}`).join(',');
  const r = await exec.query(`SELECT id, legacy_id, full_name, site_id, position, emp_no FROM employee WHERE legacy_id IN (${ph})`, uniq);
  for (const row of r.rows) {
    const entry = { id: row.id, full_name: row.full_name, site_id: row.site_id, position: row.position, emp_no: row.emp_no };
    const prev = map.get(row.legacy_id);
    if (prev) prev.push(entry); else map.set(row.legacy_id, [entry]);
  }
  return map;
}
// The row for a PF at ONE site (or undefined). Site-level PF makes (site, pf)
// the identity key; a bare ctx.existing.get(pf) is ambiguous by design now.
const pfAtSite = (ctx, pf, siteId) => (ctx.existing.get(pf) || []).find((p) => p.site_id === siteId);
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
  // Site-level PF: the balance attaches to the employee AT THIS SITE only — the
  // same number at another site is a different person (Kira ruling).
  const matchedRow = pf ? pfAtSite(ctx, pf, site_id) : undefined;
  const matched = matchedRow ? matchedRow.id : null;

  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  if (!name) exceptions.push('name missing');
  if (!Number.isFinite(balance)) exceptions.push('balance missing');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  if ([balance, accrued, taken].every(Number.isFinite) && Math.abs(balance - (accrued - taken)) > 0.5)
    exceptions.push('balance != accrued - taken (>0.5d)');
  if (matched) warnings.push('attaching to an existing employee (matched by PF)');
  // Site-level PF: a balance whose PF exists ONLY at other sites is genuine
  // ambiguity (a moved worker, or the file's site is wrong). Creating a bare
  // second person here fabricates identity (run 34 did exactly that at TSF) —
  // EXCEPTION, resolved by the data owner, never a silent create.
  if (!matched && pf && ctx.existing.has(pf))
    exceptions.push('PF is mastered at a DIFFERENT site (site-level PF) — refusing to create a duplicate person here; resolve which site owns this employee');
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
  const pf = norm(raw.pf), site = norm(raw.site);
  // Canonical template splits the name; a joined `name` column still works.
  const name = norm(raw.name) ||
    [raw.first_name, raw.middle_name, raw.surname].map(norm).filter(Boolean).join(' ');
  const position = norm(raw.position), dept = norm(raw.department || raw.dept);
  const hire_date = asDate(raw.hire_date || raw.joined_at);
  const national_id = idstr(raw.national_id), tin = idstr(raw.tin), bank = norm(raw.bank);
  // Directory-tier extras (Kira 2026-07-12).
  const level = norm(raw.level), employment_type = norm(raw.employment_type);
  const email = norm(raw.email).toLowerCase(), phone = norm(raw.phone);
  // Reporting SPLIT: a PF that must resolve, or free-text title — never both
  // fabricated into a person link.
  const reporting_to_pf = norm(raw.reporting_to_pf), reports_to_title = norm(raw.reports_to_title);
  // PII tier.
  const pii = {
    dob: asDate(raw.date_of_birth), gender: norm(raw.gender),
    bank_account: idstr(raw.bank_account), bank_branch: norm(raw.bank_branch), account_name: norm(raw.account_name),
    passport_number: idstr(raw.passport_number), citizenship: norm(raw.citizenship),
    work_permit_number: idstr(raw.work_permit_number), work_permit_validity: asDate(raw.work_permit_validity),
    nssf_number: idstr(raw.nssf_number), personal_email: norm(raw.personal_email).toLowerCase(),
    full_address: norm(raw.full_address),
    nok_relationship: norm(raw.nok_relationship), nok_name: norm(raw.nok_name), nok_contact: norm(raw.nok_contact),
  };
  const site_id = ctx.sites.get(site.toUpperCase()) || null;
  const exceptions = [], warnings = [];

  // ENRICH-BY-PF (identity-verified) under SITE-LEVEL PF (Kira ruling
  // 2026-07-12): (site, PF) is the identity key.
  //   • PF exists at THIS site → the same person: enrich (name must verify —
  //     a different name at the same site stays an exception).
  //   • PF exists only at ANOTHER site as a BARE row (identity-less stub a
  //     balances load created at a legacy/coarse site) with the SAME name →
  //     still that person: enrich + accept the master's authoritative site.
  //   • PF exists only at ANOTHER site as a MASTERED record → a legitimate
  //     cross-site duplicate: LOAD as a NEW employee at this site and FLAG for
  //     later correction (pending Head of HR approval) — never excluded, never
  //     merged. emp_no stays company-unique, so the new row carries the PF as
  //     legacy_id only and its employee number is left unassigned.
  let matched = null, correctSite = false, empnoConflict = false;
  const priors = pf ? (ctx.existing.get(pf) || []) : [];
  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  else if (priors.length) {
    const here = site_id ? priors.find((p) => p.site_id === site_id) : undefined;
    const bareElsewhere = priors.find((p) => p.site_id !== site_id && p.position == null && sameName(p.full_name, name));
    if (here) {
      if (!sameName(here.full_name, name))
        exceptions.push(`PF already loaded at THIS site with a DIFFERENT name ("${here.full_name}" vs "${name}") — verify identity, refusing to overwrite`);
      else {
        matched = here.id;
        warnings.push('enriching an existing employee (matched by PF, name verified) — identity fields filled in, leave kept');
      }
    } else if (site_id && bareElsewhere) {
      matched = bareElsewhere.id;
      correctSite = true;
      warnings.push('site corrected to the master file\'s site (previous record was identity-less at a legacy/coarse site)');
      warnings.push('enriching an existing employee (matched by PF, name verified) — identity fields filled in, leave kept');
    } else if (site_id) {
      empnoConflict = true;
      const sameNamed = priors.some((p) => sameName(p.full_name, name));
      warnings.push(`cross-site duplicate PF — loaded as a new employee at this site, FLAGGED for correction (pending Head of HR approval)${
        sameNamed ? '; the other site lists the SAME name — possibly one person in two site files' : ''}; employee number left unassigned (PF kept as legacy id)`);
    }
    // Idempotent RE-RUN of a flagged duplicate: the matched row's emp_no is
    // NULL while another site's row owns the PF as emp_no company-wide — the
    // enrich must NOT backfill it (that unique violation aborted run 34).
    if (matched && priors.some((p) => p.id !== matched && p.emp_no === pf)) empnoConflict = true;
  }
  if (!name) exceptions.push('name missing');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  // reporting_to_pf must resolve to a REAL employee — in this batch or already
  // loaded AT THIS SITE (site-level PF: a bare PF cannot point across sites).
  // Unresolvable → exception (no fabricated manager links, Kira ruling).
  if (reporting_to_pf) {
    const inBatch = (ctx.pfCount.get(reporting_to_pf) || 0) > 0;
    if (!inBatch && !pfAtSite(ctx, reporting_to_pf, site_id))
      exceptions.push(`reporting_to_pf "${reporting_to_pf}" does not resolve to a loaded employee at this site`);
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    warnings.push(`email "${email}" is not a valid address — stored for review, NOT usable as an ESS login`);
  // Email = login identity (Kira ruling 2026-07-12): NEVER shared. A duplicate
  // — within the batch or against an address already assigned to a DIFFERENT
  // employee — is an EXCEPTION, not a warning: whoever sets the password first
  // on a shared address owns the other person's payslip and personal data.
  if (email) {
    if ((ctx.emailCount.get(email) || 0) > 1)
      exceptions.push('duplicate email within this batch — a login address is personal, never shared');
    else {
      const owners = ctx.emailOwners.get(email) || [];
      if (owners.some((o) => o.id !== matched))
        exceptions.push('email already assigned to a different employee — refusing to create a shared login');
    }
  }
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
    normalized: { pf, name, site, site_id, position, dept, hire_date, national_id, tin, bank,
      level, employment_type, email, phone, reporting_to_pf, reports_to_title,
      correct_site: correctSite, empno_conflict: empnoConflict, pii },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// ── Payroll-master validation (Kira 2026-07-12) ─────────────────────────────
// Pay data behind the pay-visibility gate (employee_pay). Payroll NEVER creates
// an employee — the master must already hold the person at this site; identity
// is verified (PF at site + name), amounts must be plausible numbers. Values
// load verbatim; anomalies are flagged, never "fixed".
function validatePayroll(raw, ctx) {
  const pf = norm(raw.pf), site = norm(raw.site);
  const name = norm(raw.name) ||
    [raw.first_name, raw.middle_name, raw.surname].map(norm).filter(Boolean).join(' ');
  // A BLANK amount is ABSENT, not zero (num('') would read 0 — a real salary).
  const amt = (v) => (norm(v) === '' ? NaN : num(v));
  const basic = amt(raw.basic_salary), gross = amt(raw.gross_salary);
  const currency = norm(raw.currency).toUpperCase();
  const bank = norm(raw.bank), bank_account = idstr(raw.bank_account);
  const site_id = ctx.sites.get(site.toUpperCase()) || null;
  const exceptions = [], warnings = [];

  const prior = pf && site_id ? pfAtSite(ctx, pf, site_id) : undefined;
  if (!/^\d+$/.test(pf)) exceptions.push('PF not numeric');
  else if ((ctx.pfCount.get(pf) || 0) > 1) exceptions.push('duplicate PF within batch');
  if (!site_id) exceptions.push(`unknown site "${site}"`);
  if (site_id && /^\d+$/.test(pf) && !prior)
    exceptions.push('no employee with this PF at this site — load the employee master first (payroll never creates people)');
  if (prior && name && !sameName(prior.full_name, name))
    exceptions.push(`payroll row names a DIFFERENT person than the employee at this PF ("${prior.full_name}" vs "${name}") — verify identity`);
  if (!Number.isFinite(basic) && !Number.isFinite(gross))
    exceptions.push('neither basic nor gross salary is a number');
  for (const [label, v] of [['basic', basic], ['gross', gross]]) {
    if (Number.isFinite(v) && v < 0) exceptions.push(`${label} salary is negative`);
  }
  if (Number.isFinite(basic) && Number.isFinite(gross) && gross < basic)
    warnings.push('gross below basic — verify against the source document');
  if (!Number.isFinite(basic)) warnings.push('basic salary missing — completeness punch-list');
  if (currency && !/^[A-Z]{3}$/.test(currency)) warnings.push(`currency "${currency}" is not a 3-letter code — verify`);

  return { pf, site_id, matched_employee: prior ? prior.id : null,
    normalized: { pf, name, site, site_id, basic, gross, currency: currency || null,
      bank: bank || null, bank_account: bank_account || null },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// ── Permit validation ───────────────────────────────────────────────────────
// Keyed on PF (Kira ruling 2026-07-12) — name match is only a last-resort
// fallback needing manual confirm. Site-level PF: a PF that exists at several
// sites needs the row's site column to disambiguate; without one it is genuine
// ambiguity → exception, never a guess.
async function validatePermit(raw, ctx, exec) {
  const pf = norm(raw.pf), name = norm(raw.name), permit = norm(raw.permit || raw.permit_name);
  const expiry = norm(raw.expiry), site = norm(raw.site);
  const site_id = site ? (ctx.sites.get(site.toUpperCase()) || null) : null;
  const exceptions = [], warnings = [];
  let matched = null, by = null;
  const priors = pf ? (ctx.existing.get(pf) || []) : [];
  if (priors.length === 1) { matched = priors[0].id; by = 'pf'; }
  else if (priors.length > 1) {
    const atSite = site_id ? priors.filter((p) => p.site_id === site_id) : [];
    if (atSite.length === 1) { matched = atSite[0].id; by = 'pf+site'; }
    else exceptions.push(`PF matches employees at ${priors.length} sites — a site column is required to disambiguate (site-level PF)`);
  }
  if (priors.length === 1 && name && !sameName(priors[0].full_name, name))
    warnings.push(`permit row names "${name}" but the PF belongs to "${priors[0].full_name}" — verify against the source document`);
  if (!matched && !exceptions.length && name) {  // fall back to name match, which needs manual confirm
    const r = await exec.query('SELECT id FROM employee WHERE lower(full_name)=lower($1)', [name]);
    if (r.rows.length === 1) { matched = r.rows[0].id; by = 'name'; warnings.push('matched by name — manual confirm'); }
  }
  if (!permit) exceptions.push('permit name missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) exceptions.push('expiry required (YYYY-MM-DD)');
  if (!matched && !exceptions.some((e) => e.startsWith('PF matches')))
    exceptions.push('no employee match (PF or name)');

  return { pf, site_id: null, matched_employee: matched,
    normalized: { pf, name, permit, expiry, matched_by: by },
    exceptions, warnings, status: exceptions.length ? 'exception' : 'clean' };
}

// Control totals over the CLEAN rows. opening_balance: per-site {count,sum_balance}
// keyed by site name; employee_master: per-site {count} (a headcount check, no
// sum); payroll_master: per-site {count,sum_basic}; permit: a single {count}.
function computeControl(kind, cleanRows) {
  if (kind === 'permit') return { ALL: { count: cleanRows.length } };
  const by = {};
  for (const r of cleanRows) {
    const k = norm(r.normalized.site).toUpperCase();
    by[k] = by[k] || { count: 0, ...(kind === 'opening_balance' ? { sum_balance: 0 } : {}),
      ...(kind === 'payroll_master' ? { sum_basic: 0 } : {}) };
    by[k].count += 1;
    if (kind === 'opening_balance') by[k].sum_balance = round2(by[k].sum_balance + r.normalized.balance);
    if (kind === 'payroll_master' && Number.isFinite(r.normalized.basic))
      by[k].sum_basic = round2(by[k].sum_basic + r.normalized.basic);
  }
  return by;
}

// Normalise a caller's supplied control totals ([{site,count[,sum_balance|
// sum_basic][,allow_shortfall]}] or the permit {count}) into the same shape
// computeControl produces.
function normSupplied(kind, supplied) {
  if (kind === 'permit') {
    return { ALL: { count: Number((supplied && supplied.count) || 0),
      ...(supplied && supplied.allow_shortfall ? { allow_shortfall: true } : {}) } };
  }
  const by = {};
  for (const s of supplied || []) {
    by[norm(s.site).toUpperCase()] = { count: Number(s.count || 0),
      ...(kind === 'opening_balance' ? { sum_balance: round2(Number(s.sum_balance || 0)) } : {}),
      ...(kind === 'payroll_master' ? { sum_basic: round2(Number(s.sum_basic || 0)) } : {}),
      ...(s.allow_shortfall ? { allow_shortfall: true } : {}) };
  }
  return by;
}

function reconcile(kind, supplied, computed) {
  const mismatches = [], shortfalls = [];
  const keys = new Set([...Object.keys(supplied), ...Object.keys(computed)]);
  for (const k of keys) {
    const s = supplied[k], c = computed[k];
    if (!s) { mismatches.push({ site: k, reason: 'not in expected totals', computed: c }); continue; }
    if (!c) { mismatches.push({ site: k, reason: 'no clean rows for expected site', expected: s }); continue; }
    if (s.count !== c.count) {
      // Kira 2026-07-12: a control entry may EXPLICITLY allow a shortfall — the
      // canonical headcount stands, known-bad rows carry as flagged exceptions
      // and the gap is REPORTED, not silently absorbed. Only a shortfall is
      // tolerated: MORE clean rows than the canonical count still hard-blocks
      // (that catches duplicates and wrong-site rows). A tolerated shortfall
      // also skips the sum check for that site — with rows excepted, the sum
      // can only differ, and the shortfall report already carries the gap.
      if (s.allow_shortfall && c.count < s.count) {
        shortfalls.push({ site: k, expected: s.count, loaded: c.count, shortfall: s.count - c.count });
        continue;
      }
      mismatches.push({ site: k, field: 'count', expected: s.count, computed: c.count });
    }
    if (kind === 'opening_balance' && round2(s.sum_balance) !== round2(c.sum_balance))
      mismatches.push({ site: k, field: 'sum_balance', expected: s.sum_balance, computed: c.sum_balance });
    if (kind === 'payroll_master' && round2(s.sum_basic) !== round2(c.sum_basic))
      mismatches.push({ site: k, field: 'sum_basic', expected: s.sum_basic, computed: c.sum_basic });
  }
  return { ok: mismatches.length === 0, mismatches, ...(shortfalls.length ? { shortfalls } : {}) };
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
  // Email = login identity (Kira): batch-wide counts + current DB assignments,
  // so a duplicate can be REJECTED (exception), never silently shared.
  const emailCount = new Map(), emailOwners = new Map();
  if (kind === 'employee_master') {
    for (const r of rows) {
      const n = idstr(r.national_id), t = idstr(r.tin);
      if (n) natCount.set(n, (natCount.get(n) || 0) + 1);
      if (t) tinCount.set(t, (tinCount.get(t) || 0) + 1);
      const e = norm(r.email).toLowerCase();
      if (e) emailCount.set(e, (emailCount.get(e) || 0) + 1);
    }
    const emails = [...emailCount.keys()];
    if (emails.length) {
      const ph = emails.map((_, i) => `$${i + 1}`).join(',');
      const r = await exec.query(`SELECT id, lower(email) AS email FROM employee WHERE lower(email) IN (${ph})`, emails);
      for (const row of r.rows) {
        const prev = emailOwners.get(row.email);
        if (prev) prev.push({ id: row.id }); else emailOwners.set(row.email, [{ id: row.id }]);
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { sites, pfCount, existing, annual, openingYear, natCount, tinCount, emailCount, emailOwners, today };

  const results = [];
  for (let i = 0; i < rows.length; i++) {
    let res;
    if (kind === 'permit') res = await validatePermit(rows[i], ctx, exec);
    else if (kind === 'employee_master') res = validateEmployee(rows[i], ctx);
    else if (kind === 'payroll_master') res = validatePayroll(rows[i], ctx);
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
          // Status/leave are untouched; the master fills in what it owns. A BARE
          // record additionally accepts the master's authoritative site
          // (correct_site — e.g. legacy 'North Mara' splitting into projects).
          await c.query(
            `UPDATE employee SET emp_no = coalesce(emp_no, $2), position = $3, dept = $4,
                    joined_at = coalesce($5::date, joined_at),
                    level = $6, employment_type = $7, reports_to_title = $8,
                    email = coalesce($9, email), phone = coalesce($10, phone)
                    ${nzd.correct_site ? ', site_id = $11' : ''}
              WHERE id = $1`,
            [empId, nzd.empno_conflict ? null : nzd.pf, nzd.position || null, nzd.dept || null, nzd.hire_date,
             nzd.level || null, nzd.employment_type || null, nzd.reports_to_title || null,
             nzd.email || null, nzd.phone || null,
             ...(nzd.correct_site ? [r.site_id] : [])]);
        } else {
          // EM: create the employee through the application path (site-scoped,
          // directory-visible). PF is the legacy number AND emp_no — EXCEPT a
          // flagged cross-site duplicate, where emp_no stays company-unique so
          // the new row keeps the PF as legacy_id only (number unassigned).
          empId = await employees.create(c, session.company_id, {
            legacy_id: nzd.pf, emp_no: nzd.empno_conflict ? null : nzd.pf, full_name: nzd.name, site_id: r.site_id,
            dept: nzd.dept, position: nzd.position, joined_at: nzd.hire_date,
            role_code: 'R01', status: 'active', email: nzd.email || null, phone: nzd.phone || null,
          });
          if (nzd.level || nzd.employment_type || nzd.reports_to_title) {
            await c.query(
              `UPDATE employee SET level=$2, employment_type=$3, reports_to_title=$4 WHERE id=$1`,
              [empId, nzd.level || null, nzd.employment_type || null, nzd.reports_to_title || null]);
          }
        }
        // Confidential identity/PII → employee_pay, behind the pay gate. Only
        // write when there is something to protect ("no row", never null-flag).
        // Upsert with coalesce: enrich never blanks an existing value.
        const p = nzd.pii || {};
        const hasPii = nzd.national_id || nzd.tin || nzd.bank ||
          Object.values(p).some((v) => v);
        if (hasPii) {
          await c.query(
            `INSERT INTO employee_pay (employee_id, company_id, bank_name, national_id, tin,
                    dob, gender, bank_account, bank_branch, account_name, passport_number,
                    citizenship, work_permit_number, work_permit_validity, nssf_number,
                    personal_email, full_address, nok_relationship, nok_name, nok_contact)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             ON CONFLICT (employee_id) DO UPDATE SET
               bank_name = coalesce(EXCLUDED.bank_name, employee_pay.bank_name),
               national_id = coalesce(EXCLUDED.national_id, employee_pay.national_id),
               tin = coalesce(EXCLUDED.tin, employee_pay.tin),
               dob = coalesce(EXCLUDED.dob, employee_pay.dob),
               gender = coalesce(EXCLUDED.gender, employee_pay.gender),
               bank_account = coalesce(EXCLUDED.bank_account, employee_pay.bank_account),
               bank_branch = coalesce(EXCLUDED.bank_branch, employee_pay.bank_branch),
               account_name = coalesce(EXCLUDED.account_name, employee_pay.account_name),
               passport_number = coalesce(EXCLUDED.passport_number, employee_pay.passport_number),
               citizenship = coalesce(EXCLUDED.citizenship, employee_pay.citizenship),
               work_permit_number = coalesce(EXCLUDED.work_permit_number, employee_pay.work_permit_number),
               work_permit_validity = coalesce(EXCLUDED.work_permit_validity, employee_pay.work_permit_validity),
               nssf_number = coalesce(EXCLUDED.nssf_number, employee_pay.nssf_number),
               personal_email = coalesce(EXCLUDED.personal_email, employee_pay.personal_email),
               full_address = coalesce(EXCLUDED.full_address, employee_pay.full_address),
               nok_relationship = coalesce(EXCLUDED.nok_relationship, employee_pay.nok_relationship),
               nok_name = coalesce(EXCLUDED.nok_name, employee_pay.nok_name),
               nok_contact = coalesce(EXCLUDED.nok_contact, employee_pay.nok_contact)`,
            [empId, session.company_id, nzd.bank || null, nzd.national_id || null, nzd.tin || null,
             p.dob || null, p.gender || null, p.bank_account || null, p.bank_branch || null,
             p.account_name || null, p.passport_number || null, p.citizenship || null,
             p.work_permit_number || null, p.work_permit_validity || null, p.nssf_number || null,
             p.personal_email || null, p.full_address || null, p.nok_relationship || null,
             p.nok_name || null, p.nok_contact || null]);
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
      } else if (kind === 'payroll_master') {
        // Pay data behind the pay gate (employee_pay), upsert-with-coalesce so a
        // re-run enriches and a payroll load never blanks identity fields. The
        // matched employee was verified at validation (PF at site + name).
        await c.query(
          `INSERT INTO employee_pay (employee_id, company_id, basic_salary, gross_salary, pay_currency,
                  bank_name, bank_account)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (employee_id) DO UPDATE SET
             basic_salary = coalesce(EXCLUDED.basic_salary, employee_pay.basic_salary),
             gross_salary = coalesce(EXCLUDED.gross_salary, employee_pay.gross_salary),
             pay_currency = coalesce(EXCLUDED.pay_currency, employee_pay.pay_currency),
             bank_name    = coalesce(EXCLUDED.bank_name, employee_pay.bank_name),
             bank_account = coalesce(EXCLUDED.bank_account, employee_pay.bank_account)`,
          [r.matched_employee, session.company_id,
           Number.isFinite(nzd.basic) ? nzd.basic : null, Number.isFinite(nzd.gross) ? nzd.gross : null,
           nzd.currency || null, nzd.bank || null, nzd.bank_account || null]);
      } else {
        await c.query(
          `INSERT INTO employee_document (company_id, employee_id, kind, name, valid_until)
           VALUES ($1,$2,'permit',$3,$4)`, [session.company_id, r.matched_employee, nzd.permit, nzd.expiry]);
      }
      loaded += 1;
    }
    // Manager linking (second pass, employee_master only): a reporting_to_pf was
    // validated to resolve; link manager_id now that every row exists. Only real
    // resolutions link — a title never fabricates a person edge (Kira ruling).
    if (kind === 'employee_master') {
      for (const r of cleanRows) {
        const mgrPf = r.normalized.reporting_to_pf;
        if (!mgrPf) continue;
        // Site-level PF: both ends of the link resolve WITHIN the row's site —
        // the same number at another site is a different person.
        await c.query(
          `UPDATE employee SET manager_id = m.id
             FROM employee m
            WHERE employee.legacy_id = $1 AND employee.site_id = $3
              AND m.legacy_id = $2 AND m.site_id = $3 AND m.id <> employee.id`,
          [r.normalized.pf, mgrPf, r.site_id]);
      }
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
