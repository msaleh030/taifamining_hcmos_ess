'use strict';
// Expat permits master → TWO permits-CSV rows per person (Kira A3, 2026-07-12):
//   • 'Work Permit'      — Date issued / EXPIRE DATE  (labour / WPC reference)
//   • 'Residence Permit' — Valid from  / EXPIRY DATE  (RP reference)
// Match is by NAME downstream (the file has no PF column — Taifa is adding one
// as the permanent fix): the permit ingest's name fallback requires EXACTLY ONE
// employee match and flags it manual-confirm; zero or many matches is an
// exception (fail closed to R11 — never a fabricated person, no synthetic ids).
// A missing expiry simply does not emit that document — nothing is invented.
// Also emits a classification CSV (name, nationality) for classify-expats.
//
//   node scripts/expat-permits-convert.js <in.xlsx> <permits.csv> <classify.csv>
const fs = require('node:fs');
const { readSheet, toDate, normHdr } = require('./xlsx-to-master');

function main() {
  const [inPath, permitsOut, classifyOut] = process.argv.slice(2);
  if (!inPath || !permitsOut || !classifyOut) {
    console.error('usage: node scripts/expat-permits-convert.js <in.xlsx> <permits.csv> <classify.csv>');
    process.exit(2);
  }
  const grid = readSheet(inPath);
  let hi = -1; const ix = new Map();
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const m = new Map();
    grid[i].forEach((h, j) => { const n = normHdr(h); if (n && !m.has(n)) m.set(n, j); });
    if (m.has('name') && m.has('surname') && (m.has('expire date') || m.has('expiry date'))) {
      hi = i;
      for (const [k, v] of m) ix.set(k, v);
      break;
    }
  }
  if (hi < 0) {
    const seen = [...new Set(grid.slice(0, 10).flat().map((h) => String(h).trim()).filter(Boolean))];
    console.error(`REFUSED: no header row with Name + Surname + an expiry column. Headers seen: ${seen.join(' | ')}`);
    process.exit(1);
  }
  const g = (row, k) => { const j = ix.get(k); return j != null && j < row.length ? String(row[j]).trim() : ''; };

  const q = (v) => (/[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  const permits = ['pf,name,site,permit,expiry'];
  const classify = ['name,nationality'];
  let people = 0, workDocs = 0, residenceDocs = 0, noDates = 0;
  for (const row of grid.slice(hi + 1)) {
    const name = [g(row, 'name'), g(row, 'surname')].filter(Boolean).join(' ').trim();
    if (!name) continue;
    people++;
    classify.push([name, g(row, 'nationality')].map(q).join(','));
    const work = toDate(g(row, 'expire date'));
    const residence = toDate(g(row, 'expiry date'));
    if (/^\d{4}-\d{2}-\d{2}$/.test(work)) { permits.push(['', name, '', 'Work Permit', work].map(q).join(',')); workDocs++; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(residence)) { permits.push(['', name, '', 'Residence Permit', residence].map(q).join(',')); residenceDocs++; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(work) && !/^\d{4}-\d{2}-\d{2}$/.test(residence)) noDates++;
  }
  fs.writeFileSync(permitsOut, permits.join('\n') + '\n', { mode: 0o600 });
  fs.writeFileSync(classifyOut, classify.join('\n') + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ header_row: hi + 1, people, work_permit_docs: workDocs,
    residence_permit_docs: residenceDocs, rows_with_no_dates: noDates }));
}

main();
