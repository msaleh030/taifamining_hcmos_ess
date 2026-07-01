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
// CSV headers (case-insensitive):
//   opening-balance → pf,name,site,accrued,taken,balance[,year]
//   permits         → pf,name,permit,expiry
// control.json (expected totals, independent of the CSV):
//   opening-balance → [{"site":"North Mara","count":2,"sum_balance":25}, …]
//   permits         → {"count": 12}
const fs = require('node:fs');
const db = require('../src/db');
const cfg = require('../src/config');
const exact = require('../src/exact');
const ingest = require('../src/ingest');

const KIND_ALIAS = { 'opening-balance': 'opening_balance', opening_balance: 'opening_balance', permits: 'permit', permit: 'permit' };
const HEADERS = {
  opening_balance: { pf: 'pf', name: 'name', site: 'site', accrued: 'accrued', taken: 'taken', balance: 'balance', year: 'year' },
  permit: { pf: 'pf', name: 'name', permit: 'permit', permit_name: 'permit', expiry: 'expiry', valid_until: 'expiry' },
};

function parseFile(kind, csvPath) {
  const grid = exact.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  if (!grid.length) throw new Error('empty file');
  const map = HEADERS[kind];
  const cols = grid[0].map((h) => map[String(h).trim().toLowerCase()] || null);
  if (!cols.includes('pf') || !cols.includes('name')) throw new Error(`unrecognised header row: ${grid[0].join(',')}`);
  return grid.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => { const row = {}; cols.forEach((k, i) => { if (k) row[k] = r[i]; }); return row; });
}

async function userByEmail(email) {
  const r = await db.withOwner((c) => c.query('SELECT id, company_id, role_code FROM app_user WHERE email=$1', [email]));
  if (!r.rows[0]) throw new Error(`no app_user for ${email}`);
  return r.rows[0];
}

async function runLoad({ kind: kindIn, csvPath, controlPath, makerEmail, checkerEmail, commit = false }) {
  const kind = KIND_ALIAS[kindIn];
  if (!kind) throw new Error(`unknown kind "${kindIn}" (opening-balance | permits)`);
  const rows = parseFile(kind, csvPath);
  const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));

  const maker = await userByEmail(makerEmail);
  const checker = await userByEmail(checkerEmail);
  if (maker.company_id !== checker.company_id) throw new Error('maker and checker are in different tenants');
  if (maker.id === checker.id) throw new Error('maker-checker: maker and checker must be DIFFERENT users');

  // Faithful guard: both actors must hold an ingest.roles role — the SAME registry
  // set the endpoint enforces. (maker ≠ checker is also re-enforced by the service.)
  const allowed = await cfg.getRoleSet(maker.company_id, 'ingest.roles', '');
  for (const [who, u] of [['maker', maker], ['checker', checker]]) {
    if (!allowed.has(u.role_code)) throw new Error(`${who} role ${u.role_code} is not in ingest.roles — refused`);
  }

  const makerSession = { company_id: maker.company_id, user_id: maker.id, role_code: maker.role_code };
  const checkerSession = { company_id: checker.company_id, user_id: checker.id, role_code: checker.role_code };
  const body = { rows, control_totals: control };

  // Always preview first; the exception report is written even on a dry-run (OB-7).
  const prev = await ingest.preview(makerSession, kind, body);
  const excPath = `${csvPath}.exceptions.json`;
  fs.writeFileSync(excPath, JSON.stringify({ kind, count: prev.exception_count, exceptions: prev.exceptions }, null, 2));
  const out = { kind, rows: rows.length, clean: prev.clean_count, exceptions: prev.exception_count,
    control_ok: prev.control.ok, mismatches: prev.control.mismatches, exception_report: excPath };
  if (!commit) return { ...out, mode: 'preview', committed: false };
  if (!prev.control.ok) throw new Error('control totals do not reconcile — refusing to commit (see mismatches in the preview output)');

  const sub = await ingest.submit(makerSession, kind, body);
  const appr = await ingest.approve(checkerSession, kind, { batch_id: sub.batch_id });
  return { ...out, mode: 'commit', committed: true, batch_id: sub.batch_id, loaded: appr.loaded };
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const [kind, csvPath, controlPath, makerEmail, checkerEmail] = args.filter((a) => a !== '--commit');
  if (!kind || !csvPath || !controlPath || !makerEmail || !checkerEmail) {
    console.error('usage: node scripts/load-ingest.js <opening-balance|permits> <data.csv> <control.json> <maker-email> <checker-email> [--commit]');
    process.exit(2);
  }
  const res = await runLoad({ kind, csvPath, controlPath, makerEmail, checkerEmail, commit });
  console.log(JSON.stringify(res, null, 2));
  if (!res.committed) console.log('\nDry-run only — nothing loaded. Re-run with --commit to submit (maker) + approve (checker).');
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { runLoad, parseFile };
