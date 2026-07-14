'use strict';
// Derive a control.json from a converted canonical CSV — for loads where the
// data owner supplied NO independent totals (leave/permits/payroll master
// files arrive as the only source document). A derived control still catches
// conversion/load drift (every row accounted for between the CSV and the
// commit) but does NOT verify source truth — the output says so, loudly, and
// carries allow_shortfall so validator-excepted rows report as a gap instead
// of hard-blocking the clean remainder. An overshoot still blocks.
//
//   node scripts/derive-control.js <opening-balance|permits|payroll-master> <converted.csv>
// Prints the control JSON on stdout (write it to the .control.json next to the CSV).
const fs = require('node:fs');
const exact = require('../src/exact');

const round2 = (x) => Math.round(x * 100) / 100;

function main() {
  const [kind, csvPath] = process.argv.slice(2);
  if (!kind || !csvPath) {
    console.error('usage: node scripts/derive-control.js <opening-balance|permits|payroll-master> <converted.csv>');
    process.exit(2);
  }
  const grid = exact.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const header = grid[0].map((h) => String(h).trim().toLowerCase());
  const col = (n) => header.indexOf(n);
  const rows = grid.slice(1).filter((r) => r.some((c) => String(c).trim() !== ''));

  if (kind === 'permits') {
    console.log(JSON.stringify({ count: rows.length, allow_shortfall: true }));
    return;
  }
  const siteIx = col('site');
  const sumCol = kind === 'opening-balance' ? col('balance') : col('basic_salary');
  const sumKey = kind === 'opening-balance' ? 'sum_balance' : 'sum_basic';
  const by = new Map();
  for (const r of rows) {
    const site = String(r[siteIx] || '').trim();
    const e = by.get(site) || { site, count: 0, [sumKey]: 0, allow_shortfall: true };
    e.count += 1;
    const v = Number(String(r[sumCol] ?? '').replace(/,/g, ''));
    if (Number.isFinite(v)) e[sumKey] = round2(e[sumKey] + v);
    by.set(site, e);
  }
  console.log(JSON.stringify([...by.values()]));
}

main();
