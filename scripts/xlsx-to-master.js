'use strict';
// Convert a site's .xlsx (employee master / leave master / permits master /
// payroll master) into the CANONICAL template CSV for the loader.
// Pure conversion — intelligent on FORMAT, uncompromising on TRUTH:
//   • header row auto-detected (row 2 or 4 under merged titles);
//   • columns mapped by recognised variants (NSSF No./NSSF Number, Employment
//     Contract/Type of Employment, …) — position-independent;
//   • Excel serial dates → YYYY-MM-DD (DOB, joining, validity, expiry);
//   • names kept split (first/middle/surname) exactly as captured (the leave/
//     permits/payroll templates carry a joined name, composed verbatim);
//   • email: a SHARED mailbox (same address on >1 row) or a non-address
//     ('NIL', blank) is emitted BLANK — a shared address can never be a login.
//     Nothing else is altered; every real value passes through verbatim.
//   • the site column is STAMPED from --site (the canonical six-site model) —
//     never guessed from the file.
//
//   node scripts/xlsx-to-master.js <in.xlsx> <out.csv> --site "North Mara - TSF Lift 10 Project" [--kind master|leave|permits|payroll]
//
// Requires `unzip` (xlsx is a zip of XML). PII flows in.xlsx → out.csv only;
// nothing is printed but counts.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const normHdr = (h) => String(h == null ? '' : h).replace(/^﻿/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Header variants → canonical template column, per kind.
const MASTER_MAP = {
  'payroll no': 'pf', 'payroll number': 'pf',
  'first name': 'first_name', 'middle name': 'middle_name', 'surname': 'surname',
  'position title': 'position', 'position': 'position', 'job title': 'position',
  'department': 'department', 'level': 'level',
  'employment contract': 'employment_type', 'type of employment': 'employment_type',
  'joining date dd mm yyyy': 'hire_date', 'joining date': 'hire_date', 'date engaged': 'hire_date',
  'company email id': 'company_email', 'company email': 'company_email',
  'personal email id': 'personal_email', 'personal email': 'personal_email',
  'contact number': 'phone',
  'reporting to': 'reports_to_title', 'reporting to pf': 'reporting_to_pf',
  'nida': 'national_id', 'nida no': 'national_id', 'nida number': 'national_id',
  'date of birth dd mm yyyy': 'date_of_birth', 'date of birth': 'date_of_birth',
  'gender': 'gender', 'tin number': 'tin', 'tin no': 'tin', 'tin': 'tin',
  'bank name': 'bank_name', 'bank name branch': 'bank_name', // Dar Yard combines name+branch
  'bank account': 'bank_account', 'bank branch': 'bank_branch',
  'account name': 'account_name',
  'passport number': 'passport_number', 'citizenship': 'citizenship',
  'work permit number': 'work_permit_number', 'work permit validity': 'work_permit_validity',
  'nssf no': 'nssf_number', 'nssf number': 'nssf_number',
  'full address': 'full_address',
  'next of kin relationship': 'nok_relationship', 'next of kin name': 'nok_name',
  'contact no': 'nok_contact',
};
const NAME_MAP = { // split or joined names, shared by leave/permits/payroll
  'payroll no': 'pf', 'payroll number': 'pf', 'pf': 'pf', 'pf no': 'pf',
  'first name': 'first_name', 'middle name': 'middle_name', 'surname': 'surname',
  'name': 'name', 'full name': 'name', 'employee name': 'name', 'names': 'name',
};
const KINDS = {
  master: {
    map: MASTER_MAP,
    out: ['pf', 'first_name', 'middle_name', 'surname', 'site', 'position', 'department', 'level',
      'employment_type', 'hire_date', 'company_email', 'reporting_to_pf', 'reports_to_title', 'national_id',
      'date_of_birth', 'gender', 'tin', 'bank_name', 'bank_account', 'bank_branch', 'account_name',
      'passport_number', 'citizenship', 'work_permit_number', 'work_permit_validity', 'nssf_number',
      'personal_email', 'phone', 'full_address', 'nok_relationship', 'nok_name', 'nok_contact'],
    dates: ['hire_date', 'date_of_birth', 'work_permit_validity'],
    requires: ['pf'], // + first_name|name checked generically below
  },
  leave: {
    map: { ...NAME_MAP,
      'accrued': 'accrued', 'accrued days': 'accrued', 'days accrued': 'accrued', 'leave accrued': 'accrued',
      'leave days accrued': 'accrued', 'earned': 'accrued', 'entitlement earned': 'accrued',
      'taken': 'taken', 'days taken': 'taken', 'leave taken': 'taken', 'leave days taken': 'taken',
      'used': 'taken', 'utilised': 'taken', 'utilized': 'taken',
      'balance': 'balance', 'leave balance': 'balance', 'closing balance': 'balance',
      'balance days': 'balance', 'leave days balance': 'balance', 'opening balance': 'balance',
      'balance c f': 'balance', 'balance cf': 'balance',
      'year': 'year', 'leave year': 'year' },
    out: ['pf', 'name', 'site', 'accrued', 'taken', 'balance', 'year'],
    dates: [],
    requires: ['pf', 'balance'],
  },
  permits: {
    map: { ...NAME_MAP,
      'permit': 'permit', 'permit type': 'permit', 'permit name': 'permit', 'document': 'permit',
      'document type': 'permit', 'type of permit': 'permit',
      'expiry': 'expiry', 'expiry date': 'expiry', 'valid until': 'expiry', 'valid to': 'expiry',
      'expires': 'expiry', 'expiration date': 'expiry', 'validity': 'expiry', 'permit validity': 'expiry',
      'date of expiry': 'expiry', 'work permit validity': 'expiry',
      'site': 'site', 'site name': 'site', 'location': 'site', 'project': 'site' },
    out: ['pf', 'name', 'site', 'permit', 'expiry'],
    dates: ['expiry'],
    requires: ['pf', 'permit'],
  },
  payroll: {
    map: { ...NAME_MAP,
      'basic salary': 'basic_salary', 'basic pay': 'basic_salary', 'monthly basic': 'basic_salary',
      'basic': 'basic_salary',
      'gross salary': 'gross_salary', 'gross pay': 'gross_salary', 'gross': 'gross_salary',
      'monthly gross': 'gross_salary',
      'currency': 'currency',
      'bank name': 'bank', 'bank': 'bank', 'bank name branch': 'bank',
      'bank account': 'bank_account', 'account number': 'bank_account', 'account no': 'bank_account' },
    out: ['pf', 'name', 'site', 'basic_salary', 'gross_salary', 'currency', 'bank', 'bank_account'],
    dates: [],
    requires: ['pf'],
  },
};

// ── minimal xlsx reader: unzip -p + regex XML parse ──────────────────────────
function readSheet(path) {
  const part = (name) => execFileSync('unzip', ['-p', path, name], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
  let shared = [];
  try {
    const ss = part('xl/sharedStrings.xml');
    shared = [...ss.matchAll(/<si[ >][\s\S]*?<\/si>/g)].map((m) =>
      [...m[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join(''));
  } catch { /* no shared strings */ }
  const xml = part('xl/worksheets/sheet1.xml');
  const colIdx = (ref) => { let n = 0; for (const ch of ref.match(/^[A-Z]+/)[0]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // A styled EMPTY cell is SELF-CLOSING (<c r="B4" s="10"/>) — the alternation
    // must consume it as empty, or it would lazily swallow the NEXT cell's value
    // and shift every column after it (the PF lands under Employee ID).
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, ref, attrs, inner = ''] = cm;
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
      const is = /<is>[\s\S]*?<\/is>/.exec(inner);
      let val = '';
      if (/t="s"/.test(attrs) && v) val = shared[Number(v[1])] || '';
      else if (is) val = [...is[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unesc(t[1])).join('');
      else if (v) val = unesc(v[1]);
      cells[colIdx(ref)] = val;
    }
    const max = Math.max(-1, ...Object.keys(cells).map(Number));
    rows.push(Array.from({ length: max + 1 }, (_, i) => cells[i] ?? ''));
  }
  return rows;
}

// Excel serial → YYYY-MM-DD (1900 date system). Already-ISO strings pass through.
function toDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const n = Number(s);
  if (Number.isFinite(n) && n > 59 && n < 200000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return s; // unparseable — pass through VERBATIM; the loader flags it
}

function main() {
  const args = process.argv.slice(2);
  const take = (flag) => { const i = args.indexOf(flag); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
  const site = take('--site');
  const kindName = take('--kind') || 'master';
  const K = KINDS[kindName];
  // permits is the one COMPANY-WIDE file: no stamp — a site column in the sheet
  // passes through (it disambiguates cross-site PFs); every other kind stamps.
  if (args.length < 2 || (!site && kindName !== 'permits') || !K) {
    console.error('usage: node scripts/xlsx-to-master.js <in.xlsx> <out.csv> --site "<canonical site name>" [--kind master|leave|permits|payroll]');
    process.exit(2);
  }
  const [inPath, outPath] = args;
  const MAP = new Map(Object.entries(K.map));
  const OUT_COLS = K.out;
  const DATE_COLS = new Set(K.dates);

  const grid = readSheet(inPath);
  // Header row: the first carrying the kind's required source fields plus a
  // name (split OR joined). Fail-closed: no such row → REFUSE, listing every
  // header actually seen so the mapping can be extended deliberately.
  let hi = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const mapped = new Set(grid[i].map((h) => MAP.get(normHdr(h))).filter(Boolean));
    const hasName = mapped.has('first_name') || mapped.has('surname') || mapped.has('name');
    if (hasName && K.requires.every((f) => mapped.has(f))) { hi = i; break; }
  }
  if (hi < 0) {
    const seen = [...new Set(grid.slice(0, 10).flat().map((h) => String(h).trim()).filter(Boolean))];
    console.error(`REFUSED (${kindName}): no header row with ${K.requires.join(' + ')} + a name column in the first 10 rows. ` +
      `Headers seen: ${seen.join(' | ')}`);
    process.exit(1);
  }

  const colMap = new Map(); // out column ← source index
  const unmapped = [];
  grid[hi].forEach((h, i) => {
    const canon = MAP.get(normHdr(h));
    if (canon && !colMap.has(canon)) colMap.set(canon, i);
    else if (String(h).trim() && !canon) unmapped.push(String(h).trim());
  });

  const joinName = !colMap.has('name') && OUT_COLS.includes('name');
  const records = [];
  const emailCount = new Map();
  for (const row of grid.slice(hi + 1)) {
    const g = (c) => { const i = colMap.get(c); return i != null && i < row.length ? String(row[i]).trim() : ''; };
    if (!g('pf') && !g('first_name') && !g('surname') && !g('name')) continue; // blank line
    const rec = {};
    for (const c of OUT_COLS) {
      if (c === 'site') { rec.site = site || g('site'); continue; }
      if (c === 'name' && joinName) { // leave/permits/payroll templates carry a joined name
        rec.name = [g('first_name'), g('middle_name'), g('surname')].filter(Boolean).join(' ');
        continue;
      }
      let v = g(c);
      if (DATE_COLS.has(c)) v = toDate(v);
      if (c === 'reports_to_title' && /^\d+$/.test(v)) { rec.reporting_to_pf = v; v = ''; } // a PF, not a title
      rec[c] = v;
    }
    const em = (rec.company_email || '').toLowerCase();
    if (em) emailCount.set(em, (emailCount.get(em) || 0) + 1);
    records.push(rec);
  }
  // Email rule: personal + unique, or BLANK. Shared mailboxes and non-addresses
  // can never be ESS logins (master kind only — the others carry no email).
  let blanked = 0;
  for (const r of records) {
    const em = (r.company_email || '').toLowerCase();
    if (em && ((emailCount.get(em) || 0) > 1 || !em.includes('@'))) { r.company_email = ''; blanked++; }
  }

  const q = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = [OUT_COLS.join(',')]
    .concat(records.map((r) => OUT_COLS.map((c) => q(String(r[c] ?? ''))).join(',')))
    .join('\n') + '\n';
  fs.writeFileSync(outPath, csv, { mode: 0o600 });
  console.log(JSON.stringify({ kind: kindName, site, header_row: hi + 1, records: records.length,
    ...(kindName === 'master' ? { emails_blanked_shared_or_invalid: blanked } : {}),
    unmapped_columns: unmapped }));
}

if (require.main === module) main();
module.exports = { readSheet, toDate, normHdr };
