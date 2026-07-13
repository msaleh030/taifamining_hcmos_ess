'use strict';
// Wave 3 (Kira 2026-07-13) — REPORT ONLY on newly-arrived source files. This
// script NEVER loads, NEVER writes a canonical CSV, NEVER touches the DB. It
// reads an .xlsx off /root/uat-data with the SAME reader the loader uses
// (scripts/xlsx-to-master.js readSheet) and prints forensics: row count, PF
// collisions, NIDA-stored-as-number precision loss, missing TINs, leave
// accruals over 100 days, and any 'as at' date in the title band.
//
// PII DISCIPLINE: it prints COUNTS, CLASSIFICATIONS and LENGTHS only. It never
// prints a NIDA, a TIN, a name or a bank number. Payroll numbers (PF) ARE
// printed for the collision list — they are internal identifiers, not PII, and
// a collision is not actionable without them (Wave 2 printed them the same way).
//
//   node scripts/wave3-file-forensic.js <in.xlsx> --kind leave|payroll|master
const path = require('node:path');
const { readSheet, normHdr } = require(path.join(__dirname, 'xlsx-to-master.js'));

// Header synonyms we care about for the forensic, independent of load mapping —
// we scan the RAW header so a NIDA/TIN column is found even when the leave kind
// would not map it.
const SYN = {
  pf: ['payroll no', 'payroll number', 'pf', 'pf no', 'payroll', 'employee id'],
  name: ['name', 'full name', 'employee name', 'names', 'first name', 'surname'],
  nida: ['nida', 'nida no', 'nida number', 'national id', 'national id no', 'national id number',
    'national identification', 'national identification number', 'national identity number', 'nin', 'nin no'],
  tin: ['tin', 'tin no', 'tin number'],
  accrued: ['accrued', 'accrued days', 'days accrued', 'leave accrued', 'leave days accrued', 'earned', 'entitlement earned'],
  taken: ['taken', 'days taken', 'leave taken', 'leave days taken', 'used', 'utilised', 'utilized'],
  balance: ['balance', 'leave balance', 'closing balance', 'balance days', 'leave days balance',
    'opening balance', 'current balance', 'balance c f', 'balance cf'],
  basic_salary: ['basic salary', 'basic pay', 'monthly basic', 'basic'],
  gross_salary: ['gross salary', 'gross pay', 'gross', 'monthly gross'],
};

function main() {
  const args = process.argv.slice(2);
  const kindIdx = args.indexOf('--kind');
  const kind = kindIdx >= 0 ? args[kindIdx + 1] : 'master';
  const inPath = args.find((a) => a.endsWith('.xlsx'));
  if (!inPath) { console.error('usage: node scripts/wave3-file-forensic.js <in.xlsx> --kind leave|payroll|master'); process.exit(2); }

  const grid = readSheet(inPath);
  const merges = grid.merges || [];
  const expandedRow = (ri) => {
    const base = [...(grid[ri] || [])];
    for (const m of merges) {
      if (m.r1 !== ri || m.r2 !== ri) continue;
      const label = String(base[m.c1] || '').trim();
      if (!label) continue;
      for (let c = m.c1; c <= m.c2; c++) { while (base.length <= c) base.push(''); if (!String(base[c] || '').trim()) base[c] = label; }
    }
    return base;
  };
  const matchSyn = (h, key) => SYN[key].includes(normHdr(h));

  // Header row: first of the first 12 that carries a PF-like AND a name-like column.
  let hi = -1;
  for (let i = 0; i < Math.min(grid.length, 12); i++) {
    const row = expandedRow(i);
    const hasPf = row.some((h) => matchSyn(h, 'pf'));
    const hasName = row.some((h) => matchSyn(h, 'name'));
    if (hasPf && hasName) { hi = i; break; }
  }
  if (hi < 0) {
    const seen = [...new Set(grid.slice(0, 12).flat().map((h) => String(h).trim()).filter(Boolean))];
    console.log(JSON.stringify({ file: path.basename(inPath), kind, error: 'no header row (pf + name) in first 12 rows', headers_seen: seen }));
    return;
  }
  const hdr = expandedRow(hi);
  const col = {}; // key -> first matching column index
  for (const key of Object.keys(SYN)) {
    const i = hdr.findIndex((h) => matchSyn(h, key));
    if (i >= 0) col[key] = i;
  }
  const unmapped = hdr.map((h) => String(h).trim()).filter(Boolean);

  // 'AS AT' date — scan the title band (rows above the header) and the header
  // row itself for 'as at' / 'as of', and report the whole cell verbatim (a
  // date, not PII).
  const asAt = [];
  for (let i = 0; i <= hi; i++) {
    for (const cell of (grid[i] || [])) {
      const s = String(cell || '').trim();
      if (/\bas[\s-]?(at|of)\b/i.test(s)) asAt.push(s);
    }
  }

  // Data rows.
  const rows = grid.slice(hi + 1).filter((r) => {
    const pf = col.pf != null ? String(r[col.pf] || '').trim() : '';
    const nm = col.name != null ? String(r[col.name] || '').trim() : '';
    return pf || nm;
  });

  // PF collisions.
  const pfCount = new Map();
  for (const r of rows) {
    const pf = col.pf != null ? String(r[col.pf] || '').trim() : '';
    if (pf) pfCount.set(pf, (pfCount.get(pf) || 0) + 1);
  }
  const pfCollisions = [...pfCount.entries()].filter(([, n]) => n > 1).map(([pf, n]) => ({ pf, rows: n }));
  const pfBlank = rows.filter((r) => col.pf != null && !String(r[col.pf] || '').trim()).length;

  // NIDA precision: classify each non-blank NIDA cell. TZ NIDA is 20 digits; a
  // 20-digit value typed as a NUMBER cannot survive float64 (exact only to ~15
  // digits), so it lands as scientific notation or a rounded integer.
  let nida = null;
  if (col.nida != null) {
    const cls = { blank: 0, text_preserved: 0, sci_notation_LOST: 0, numeric_rounded_RISK: 0, numeric_ok: 0 };
    const lenHist = {};
    for (const r of rows) {
      const raw = String(r[col.nida] ?? '').trim();
      if (!raw) { cls.blank++; continue; }
      const digits = raw.replace(/\D/g, '');
      lenHist[digits.length] = (lenHist[digits.length] || 0) + 1;
      if (/[eE]/.test(raw)) { cls.sci_notation_LOST++; continue; }
      if (/^\d+$/.test(raw)) {
        // pure number: >2^53 means it could not have been exact as a float.
        if (raw.length >= 16 && Number(raw) > Number.MAX_SAFE_INTEGER) cls.numeric_rounded_RISK++;
        else cls.numeric_ok++;
      } else {
        cls.text_preserved++; // contains a non-digit (space/dash) -> was a string, exact
      }
    }
    nida = { classification: cls, digit_length_histogram: lenHist,
      note: 'sci_notation_LOST + numeric_rounded_RISK = NIDA values that lost precision by being stored as a number' };
  }

  // TIN fill.
  let tin = null;
  if (col.tin != null) {
    const filled = rows.filter((r) => String(r[col.tin] ?? '').trim() !== '').length;
    tin = { total: rows.length, filled, missing: rows.length - filled };
  }

  // Leave accruals / balances over 100 days.
  const over100 = {};
  for (const k of ['accrued', 'balance', 'taken']) {
    if (col[k] == null) continue;
    let over = 0; const examples = [];
    for (const r of rows) {
      const n = Number(String(r[col[k]] ?? '').replace(/,/g, '').trim());
      if (Number.isFinite(n) && n > 100) { over++; if (examples.length < 5) examples.push(n); }
    }
    over100[k] = { over_100_days: over, example_values: examples };
  }

  const out = {
    file: path.basename(inPath), kind, header_row: hi + 1, data_rows: rows.length,
    columns_found: Object.fromEntries(Object.entries(col).map(([k, v]) => [k, hdr[v]])),
    as_at_dates: [...new Set(asAt)],
    pf: { distinct: pfCount.size, blank_pf_rows: pfBlank, collisions: pfCollisions },
    nida, tin, leave_over_100: Object.keys(over100).length ? over100 : null,
    all_headers: unmapped,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
