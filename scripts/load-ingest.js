'use strict';
// Load UAT test data (opening balances / permits) through the INGESTION
// discipline — never a raw INSERT. Dry-run (preview) by default; --commit drives
// the maker-checker submit → approve. Every control the endpoint enforces is
// preserved here:
//   • both actors must hold an ingest.roles role (same registry set, checked);
//   • maker ≠ checker (checked early for UX; ALSO enforced by the service);
//   • control totals come from an INDEPENDENT control.json (the source document's
//     expected totals), and a mismatch refuses the commit (hard block);
//   • the batch is atomic; the exception report is written next to the input.
//
//   node scripts/load-ingest.js opening-balance balances.csv control.json \
//        maker@taifamining.tz checker@taifamining.tz [--commit]
//
// SMART PARSING — intelligent on FORMAT, uncompromising on TRUTH:
//   • auto-detects the header row (real sheets bury it under merged title rows —
//     e.g. the North Mara master's header sits at row 8);
//   • maps columns by recognising common header variants (EMPLOYEE ID / PF /
//     Payroll No → pf; FULL NAME / Name → name; DATE ENGAGED → hire_date; …);
//   • FAILS CLOSED on genuine ambiguity: two columns claiming the same field, or
//     a required field it cannot find, REFUSE with a report — it never guesses.
//     Data-level ambiguity (duplicate PFs, unmatched names, policy calls) stays
//     with the server-side validators, which report exceptions, never fabricate.
// control.json (expected totals, independent of the CSV):
//   opening-balance → [{"site":"North Mara","count":2,"sum_balance":25}, …]
//   permits         → {"count": 12}
//   employee-master → [{"site":"North Mara","count":285}]   (headcount per site)
const fs = require('node:fs');
const db = require('../src/db');
const cfg = require('../src/config');
const exact = require('../src/exact');
const ingest = require('../src/ingest');

const KIND_ALIAS = { 'opening-balance': 'opening_balance', opening_balance: 'opening_balance', permits: 'permit', permit: 'permit',
  'employee-master': 'employee_master', employee_master: 'employee_master', employees: 'employee_master',
  'payroll-master': 'payroll_master', payroll_master: 'payroll_master', payroll: 'payroll_master' };

// Header-variant recognition. Keys are NORMALISED header text (lowercase,
// punctuation → space). Only unambiguous, widely-used payroll/HR spellings are
// listed — a header outside this table is reported as unmapped, never guessed.
const COMMON_SYNONYMS = {
  pf:   ['pf', 'pf no', 'pf number', 'employee id', 'emp id', 'employee no', 'employee number',
         'payroll no', 'payroll number', 'staff no', 'staff number'],
  name: ['name', 'names', 'full name', 'fullname', 'employee name', 'employee names'],
  site: ['site', 'site name', 'location', 'mine site'],
};
const KIND_SYNONYMS = {
  opening_balance: {
    ...COMMON_SYNONYMS,
    accrued: ['accrued', 'accrued days', 'days accrued', 'leave accrued', 'earned'],
    taken:   ['taken', 'days taken', 'leave taken', 'used', 'utilised', 'utilized'],
    balance: ['balance', 'bal', 'balance days', 'leave balance', 'closing balance'],
    year:    ['year', 'leave year'],
  },
  permit: {
    pf: COMMON_SYNONYMS.pf, name: COMMON_SYNONYMS.name, site: COMMON_SYNONYMS.site,
    permit: ['permit', 'permit name', 'permit type', 'document', 'licence', 'license'],
    expiry: ['expiry', 'expiry date', 'valid until', 'valid to', 'expires', 'expiration date',
             'validity', 'permit validity', 'date of expiry'],
  },
  payroll_master: {
    ...COMMON_SYNONYMS,
    first_name: ['first name'], middle_name: ['middle name'], surname: ['surname', 'last name'],
    basic_salary: ['basic salary', 'basic pay', 'monthly basic', 'basic'],
    gross_salary: ['gross salary', 'gross pay', 'gross', 'monthly gross'],
    currency:     ['currency'],
    bank:         ['bank', 'bank name'],
    bank_account: ['bank account', 'account number', 'account no'],
  },
  employee_master: {
    ...COMMON_SYNONYMS,
    // Split names (the real files + the canonical template carry these).
    first_name:  ['first name'],
    middle_name: ['middle name'],
    surname:     ['surname', 'last name'],
    position:    ['position', 'position title', 'job title', 'title', 'designation'],
    department:  ['department', 'dept', 'section'],
    level:       ['level', 'grade'],
    employment_type: ['employment type', 'type of employment', 'employment contract', 'contract type'],
    hire_date:   ['hire date', 'hired', 'date engaged', 'engagement date', 'date of employment',
                  'employment date', 'start date', 'joined', 'join date', 'date joined', 'joined at',
                  'joining date', 'joining date dd mm yyyy'],
    email:       ['email', 'company email', 'company email id'],
    phone:       ['phone', 'contact number', 'mobile', 'phone number'],
    // Reporting is SPLIT (Kira 2026-07-12): a PF that must resolve, or a free-
    // text title — never a fabricated person link.
    reporting_to_pf:  ['reporting to pf', 'manager pf', 'supervisor pf'],
    reports_to_title: ['reports to title', 'reporting to', 'reports to'],
    national_id: ['national id', 'national id no', 'nida', 'nida no', 'nida number', 'nin'],
    date_of_birth: ['date of birth', 'dob', 'date of birth dd mm yyyy'],
    gender:      ['gender', 'sex'],
    tin:         ['tin', 'tin no', 'tin number'],
    bank:        ['bank', 'bank name'],
    bank_account: ['bank account', 'account number', 'account no'],
    bank_branch: ['bank branch', 'branch'],
    account_name: ['account name'],
    passport_number: ['passport number', 'passport no', 'passport'],
    citizenship: ['citizenship', 'nationality'],
    work_permit_number:   ['work permit number', 'work permit no'],
    work_permit_validity: ['work permit validity', 'work permit expiry', 'permit validity'],
    nssf_number: ['nssf number', 'nssf no', 'nssf'],
    personal_email: ['personal email', 'personal email id'],
    full_address: ['full address', 'address'],
    nok_relationship: ['next of kin relationship', 'nok relationship'],
    nok_name:    ['next of kin name', 'nok name'],
    nok_contact: ['next of kin contact', 'nok contact', 'contact no'],
  },
};
// A row only counts as THE header when every required field is present on it.
// An inner array means ANY-OF (e.g. a joined `name` column OR a split surname).
const REQUIRED = {
  opening_balance: ['pf', 'name', 'site', 'balance'],
  permit: ['pf', 'name', 'permit', 'expiry'],
  employee_master: ['pf', 'site', ['name', 'surname']],
  payroll_master: ['pf', 'site', ['name', 'surname'], ['basic_salary', 'gross_salary']],
};
const HEADER_SCAN_ROWS = 30; // merged-title preambles are shallow; scan the top of the sheet

const normHeader = (h) => String(h == null ? '' : h).replace(/^﻿/, '')
  .trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Build a reverse lookup (normalised variant → canonical field) for a kind.
function variantMap(kind) {
  const m = new Map();
  for (const [field, variants] of Object.entries(KIND_SYNONYMS[kind])) {
    for (const v of variants) m.set(v, field);
  }
  return m;
}

// Try to read one grid row as the header. Returns the column mapping, any
// duplicate claims (two columns → one field), and unmapped headers.
function tryHeaderRow(row, lookup) {
  const cols = [];               // column index → canonical field (or null)
  const byField = new Map();     // canonical field → [source header, …]
  const unmapped = [];
  row.forEach((cell, i) => {
    const n = normHeader(cell);
    const field = n ? lookup.get(n) : null;
    cols.push(field || null);
    if (field) byField.set(field, [...(byField.get(field) || []), String(cell).trim()]);
    else if (n) unmapped.push(String(cell).trim());
  });
  const duplicates = [...byField.entries()].filter(([, srcs]) => srcs.length > 1);
  return { cols, byField, duplicates, unmapped, matched: byField.size };
}

// Locate the header row: the FIRST row (within the scan window) on which every
// required field maps. No such row → refuse, showing the best near-miss so the
// operator can see exactly what was and wasn't recognised. Never guesses.
function detectHeader(grid, kind) {
  const lookup = variantMap(kind);
  const required = REQUIRED[kind];
  // An inner array is ANY-OF: satisfied when at least one alternative mapped.
  const missingOf = (attempt) => required
    .filter((f) => (Array.isArray(f) ? !f.some((alt) => attempt.byField.has(alt)) : !attempt.byField.has(f)))
    .map((f) => (Array.isArray(f) ? f.join('|') : f));
  let best = null;
  const limit = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < limit; r++) {
    const attempt = tryHeaderRow(grid[r], lookup);
    if (!best || attempt.matched > best.attempt.matched) best = { row: r, attempt };
    const missing = missingOf(attempt);
    if (missing.length === 0) {
      // FAIL-CLOSED on ambiguity: two source columns claiming one field is a
      // question only the data owner can answer.
      if (attempt.duplicates.length) {
        const d = attempt.duplicates.map(([f, srcs]) => `"${srcs.join('" and "')}" both map to ${f}`).join('; ');
        throw new Error(`ambiguous header row ${r + 1}: ${d} — refusing to guess which column is authoritative`);
      }
      return { rowIndex: r, ...attempt };
    }
  }
  const near = best
    ? ` Closest candidate: row ${best.row + 1} (matched: ${[...best.attempt.byField.keys()].join(', ') || 'none'}; ` +
      `missing required: ${missingOf(best.attempt).join(', ')}).`
    : '';
  const req = required.map((f) => (Array.isArray(f) ? f.join('|') : f)).join(', ');
  throw new Error(`no usable header row found in the first ${limit} rows — need columns for: ${req}.${near} ` +
    `Recognised variants exist for each (e.g. EMPLOYEE ID/Payroll No → pf; FULL NAME → name); rename the headers or extend the mapping.`);
}

function parseFile(kind, csvPath) {
  const grid = exact.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (!grid.length) throw new Error('empty file');
  const header = detectHeader(grid, kind);
  const rows = grid.slice(header.rowIndex + 1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => { const row = {}; header.cols.forEach((k, i) => { if (k) row[k] = r[i]; }); return row; });
  // The mapping report makes the auto-detection auditable: exactly which source
  // header fed each field, and which columns were left alone.
  const mapping = {
    header_row: header.rowIndex + 1,
    fields: Object.fromEntries([...header.byField.entries()].map(([f, srcs]) => [f, srcs[0]])),
    unmapped_columns: header.unmapped,
  };
  return { rows, mapping };
}

async function userByEmail(email) {
  const r = await db.withOwner((c) => c.query('SELECT id, company_id, role_code FROM app_user WHERE email=$1', [email]));
  if (!r.rows[0]) throw new Error(`no app_user for ${email}`);
  return r.rows[0];
}

async function runLoad({ kind: kindIn, csvPath, controlPath, makerEmail, checkerEmail, commit = false }) {
  const kind = KIND_ALIAS[kindIn];
  if (!kind) throw new Error(`unknown kind "${kindIn}" (opening-balance | permits | employee-master | payroll-master)`);
  const { rows, mapping } = parseFile(kind, csvPath);
  const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));

  const maker = await userByEmail(makerEmail);
  const checker = await userByEmail(checkerEmail);
  if (maker.company_id !== checker.company_id) throw new Error('maker and checker are in different tenants');
  if (maker.id === checker.id) throw new Error('maker-checker: maker and checker must be DIFFERENT users');

  // Faithful guard (v1.5 LI-6): the maker must hold an ingest.maker.roles role
  // (Finance Manager) and the checker an ingest.checker.roles role (CFC) — the
  // SAME disjoint SoD sets the service enforces. maker ≠ checker re-enforced too.
  const makers = await cfg.getRoleSet(maker.company_id, 'ingest.maker.roles', '');
  const checkers = await cfg.getRoleSet(checker.company_id, 'ingest.checker.roles', '');
  if (!makers.has(maker.role_code)) throw new Error(`maker role ${maker.role_code} is not in ingest.maker.roles — refused`);
  if (!checkers.has(checker.role_code)) throw new Error(`checker role ${checker.role_code} is not in ingest.checker.roles — refused`);

  const makerSession = { company_id: maker.company_id, user_id: maker.id, role_code: maker.role_code };
  const checkerSession = { company_id: checker.company_id, user_id: checker.id, role_code: checker.role_code };
  const body = { rows, control_totals: control };

  // Always preview first; the exception report is written even on a dry-run (OB-7).
  const prev = await ingest.preview(makerSession, kind, body);
  const excPath = `${csvPath}.exceptions.json`;
  fs.writeFileSync(excPath, JSON.stringify({ kind, count: prev.exception_count, exceptions: prev.exceptions }, null, 2));
  // Rows that loaded clean but carry anomaly/punch-list warnings (format
  // anomalies, blank punch-list fields, deficits) — surfaced, never blocking.
  const warned = prev.clean.filter((r) => r.warnings && r.warnings.length).length;
  // KIND histograms with raw values masked (quoted strings and digit runs) —
  // some texts embed emails/TINs/names, and this summary flows to a CI log.
  // The full texts stay in the on-box exception report / preview only.
  const mask = (t) => String(t).replace(/"[^"]*"/g, '"…"').replace(/\d[\d./-]*/g, '#');
  const histogram = (lists) => {
    const h = {};
    for (const items of lists) for (const t of items || []) { const k = mask(t); h[k] = (h[k] || 0) + 1; }
    return h;
  };
  const out = { kind, mapping, rows: rows.length, clean: prev.clean_count, warned,
    warning_kinds: histogram(prev.clean.map((r) => r.warnings)),
    exceptions: prev.exception_count,
    exception_kinds: histogram(prev.exceptions.map((e) => e.exceptions)),
    control_ok: prev.control.ok, mismatches: prev.control.mismatches, exception_report: excPath };
  if (!commit) return { ...out, mode: 'preview', committed: false };
  if (!prev.control.ok) {
    // Show WHAT failed — site names + expected/computed numbers + masked
    // exception kinds (CI-safe); the full rows are in the exception report.
    throw new Error('control totals do not reconcile — refusing to commit. ' +
      JSON.stringify({ mismatches: prev.control.mismatches, exception_kinds: out.exception_kinds }));
  }

  const sub = await ingest.submit(makerSession, kind, body);
  const appr = await ingest.approve(checkerSession, kind, { batch_id: sub.batch_id });
  return { ...out, mode: 'commit', committed: true, batch_id: sub.batch_id, loaded: appr.loaded };
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const [kind, csvPath, controlPath, makerEmail, checkerEmail] = args.filter((a) => a !== '--commit');
  if (!kind || !csvPath || !controlPath || !makerEmail || !checkerEmail) {
    console.error('usage: node scripts/load-ingest.js <opening-balance|permits|employee-master|payroll-master> <data.csv> <control.json> <maker-email> <checker-email> [--commit]');
    process.exit(2);
  }
  const res = await runLoad({ kind, csvPath, controlPath, makerEmail, checkerEmail, commit });
  console.log(JSON.stringify(res, null, 2));
  if (!res.committed) console.log('\nDry-run only — nothing loaded. Re-run with --commit to submit (maker) + approve (checker).');
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { runLoad, parseFile };
