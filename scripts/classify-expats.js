#!/usr/bin/env node
'use strict';
// Expat classification backfill (Kira, 2026-07-06). Input: the authoritative
// expat-permit-classification.csv (61 expatriates — name, passport,
// nationality, permit expiries). The file is CLIENT PII: it lives on the box
// (e.g. /root/uat-data/), is NEVER committed to the repo, and this script
// prints ONLY counts to stdout — names go to the 600-mode report file.
//
//   UAT_COMPANY=<tenant uuid> node scripts/classify-expats.js <csv> [reportPath]
//
// Rules (flag, don't guess):
//   • a list row that matches EXACTLY ONE employee by normalised name (or
//     reversed token order) → employee.is_expat=true, and their NULL-typed
//     permit documents → permit_type='expat' (route/visibility R11).
//   • a row with zero or multiple candidates is UNMATCHED — written to the
//     report for Kira/Baraka, never guessed. (Passport matching would break
//     ties, but no passport field exists on the employee record — noted.)
//   • locals' defaults (everyone not on the list → permit_type='business')
//     are applied ONLY when every list row matched. While any row is
//     unresolved, an unmatched expat's documents could otherwise be
//     mis-defaulted to the R06 leg — so the blanket is HELD and unclassified
//     rows keep failing closed to R11 (safe). Re-run after resolving, or
//     force with FORCE_LOCAL_DEFAULTS=1 (Kira/Baraka's call).
const fs = require('node:fs');
const db = require('../src/db');

// Minimal RFC-4180 CSV (quotes, embedded commas/newlines).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const reversed = (s) => norm(s).split(' ').reverse().join(' ');

async function main() {
  const company = process.env.UAT_COMPANY;
  const csvPath = process.argv[2] || '/root/uat-data/expat-permit-classification.csv';
  const reportPath = process.argv[3] || 'expat-classification-report.txt';
  if (!company) throw new Error('set UAT_COMPANY');
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (!rows.length) throw new Error('empty CSV');
  const header = rows[0].map((h) => norm(h));
  const col = (want) => header.findIndex((h) => want.some((w) => h.includes(w)));
  const nameCol = col(['name']);
  if (nameCol < 0) throw new Error('no name column in the CSV header');
  const natCol = col(['national']);
  // Kira ruling 2026-07-12: key on PF, not name — the permits master carries a
  // payroll number, which removes the 3-of-61 name-matching problem entirely.
  // Name matching stays only as the fallback for rows without a PF.
  const pfCol = col(['payroll', 'pf', 'employee id', 'staff no']);
  const list = rows.slice(1).map((r) => ({
    name: r[nameCol], nationality: natCol >= 0 ? r[natCol] : '',
    pf: pfCol >= 0 ? String(r[pfCol] || '').trim() : '',
  })).filter((r) => norm(r.name) || r.pf);

  const out = await db.withOwner(async (c) => {
    const emps = (await c.query(
      `SELECT id, full_name, legacy_id FROM employee WHERE company_id=$1`, [company])).rows;
    const byName = new Map(), byPf = new Map();
    for (const e of emps) {
      for (const k of new Set([norm(e.full_name), reversed(e.full_name)])) {
        if (!k) continue;
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(e.id);
      }
      if (e.legacy_id) {
        if (!byPf.has(e.legacy_id)) byPf.set(e.legacy_id, []);
        byPf.get(e.legacy_id).push(e.id);
      }
    }

    const matched = [], unmatched = [];
    for (const row of list) {
      // PF first (authoritative). Site-level PF: the same number at several
      // sites is >1 candidate — reported for resolution, never guessed.
      if (row.pf && byPf.has(row.pf)) {
        const cands = byPf.get(row.pf);
        if (cands.length === 1) { matched.push({ ...row, employee_id: cands[0], by: 'pf' }); continue; }
        unmatched.push({ ...row, candidates: cands.length, why: 'PF at multiple sites' });
        continue;
      }
      const cands = new Set([...(byName.get(norm(row.name)) || []), ...(byName.get(reversed(row.name)) || [])]);
      if (cands.size === 1) matched.push({ ...row, employee_id: [...cands][0], by: 'name' });
      else unmatched.push({ ...row, candidates: cands.size, why: row.pf ? 'PF unknown, name ambiguous/absent' : 'name-only' });
    }

    let docsExpat = 0;
    for (const m of matched) {
      await c.query(`UPDATE employee SET is_expat=true WHERE id=$1 AND is_expat=false`, [m.employee_id]);
      const d = await c.query(
        `UPDATE employee_document SET permit_type='expat'
          WHERE employee_id=$1 AND kind='permit' AND permit_type IS NULL`, [m.employee_id]);
      docsExpat += d.rowCount || 0;
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        company, 'script:classify-expats', 'SYS', 'employee.expat.classify',
        'employee', m.employee_id, { is_expat: false }, { is_expat: true, source: 'expat-permit-classification.csv' }]);
    }

    let docsBusiness = 0, localsApplied = false;
    if (unmatched.length === 0 || process.env.FORCE_LOCAL_DEFAULTS === '1') {
      const d = await c.query(
        `UPDATE employee_document d SET permit_type='business'
           FROM employee e
          WHERE e.id = d.employee_id AND d.company_id=$1
            AND d.kind='permit' AND d.permit_type IS NULL AND e.is_expat=false`, [company]);
      docsBusiness = d.rowCount || 0;
      localsApplied = true;
    }
    return { matched, unmatched, docsExpat, docsBusiness, localsApplied, totalEmployees: emps.length };
  });

  // Names/PII go ONLY to the report file (600); stdout carries counts.
  const lines = [
    `expat classification report — ${csvPath}`,
    `list rows: ${out.matched.length + out.unmatched.length} · matched: ${out.matched.length} · unmatched: ${out.unmatched.length}`,
    '', 'MATCHED (is_expat=true set):',
    ...out.matched.map((m) => `  ${m.name}${m.nationality ? ` (${m.nationality})` : ''} -> employee ${m.employee_id} (by ${m.by || 'name'})`),
    '', 'UNMATCHED (resolve with Kira/Baraka — NEVER guessed; 0 or >1 candidates):',
    ...(out.unmatched.length ? out.unmatched.map((u) => `  ${u.name}${u.nationality ? ` (${u.nationality})` : ''} — ${u.candidates} candidate(s)${u.why ? ` [${u.why}]` : ''}`) : ['  (none)']),
    '', 'note: rows with a PF match by PF (authoritative); name matching is the fallback only.',
  ];
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', { mode: 0o600 });

  /* eslint-disable no-console */
  console.log(`expats matched          : ${out.matched.length}`);
  console.log(`unmatched (report file) : ${out.unmatched.length}`);
  console.log(`permit docs -> expat    : ${out.docsExpat}`);
  console.log(out.localsApplied
    ? `permit docs -> business : ${out.docsBusiness} (locals' default applied)`
    : `permit docs -> business : HELD — ${out.unmatched.length} unmatched row(s); unclassified rows keep failing closed to R11 (safe). Resolve + re-run, or FORCE_LOCAL_DEFAULTS=1.`);
  console.log(`report (names, 600)     : ${reportPath}`);
  await db.close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
