'use strict';
// READ-AND-REPORT for /root/uat-data/User_Accounts_Matrix.xlsx (Kira,
// 2026-07-12). Kira's instruction: "READ IT FIRST AND REPORT BEFORE
// PROVISIONING ANYTHING." This script PROVISIONS NOTHING — it reports what
// the matrix contains and flags every row that would violate the auth split:
//
//   CONSOLE = email + password + MFA (never a PIN)
//   ESS     = device + PIN         (never a console credential)
//   One person on both surfaces = TWO credentials, never one.
//
// CI-safe stdout: column names, row/role/site counts, flag counts. Per-row
// detail (names/emails — PII) goes ONLY to the 600-mode on-box report.
//
//   UAT_COMPANY=<uuid> node scripts/report-user-matrix.js <matrix.xlsx> [reportPath]
const fs = require('node:fs');
const db = require('../src/db');
const { readSheet, normHdr } = require('./xlsx-to-master');

const KNOWN_ROLES = new Set(['R01','R02','R03','R04','R05','R06','R07','R08','R09','R10','R11','R12','R13','R14','R15','R16']);
// Column variants → canonical. Credential-VALUE columns are recognised so we
// can WARN that plaintext credentials are present in a spreadsheet (they will
// not be echoed anywhere) — never to load them.
const MAP = new Map(Object.entries({
  'name': 'name', 'full name': 'name', 'employee name': 'name', 'user name': 'name', 'account name': 'name',
  'first name': 'first_name', 'middle name': 'middle_name', 'surname': 'surname',
  'email': 'email', 'email id': 'email', 'company email': 'email', 'company email id': 'email',
  'login email': 'email', 'login email id': 'email',
  'login': 'login', 'username': 'login', 'user id': 'login',
  'role': 'role', 'role code': 'role', 'user role': 'role', 'access role': 'role', 'access level': 'role',
  'site': 'site', 'sites': 'site', 'location': 'site', 'project': 'site', 'site scope': 'site',
  'pf': 'pf', 'pf no': 'pf', 'payroll no': 'pf', 'payroll number': 'pf', 'employee id': 'pf',
  'surface': 'surface', 'system': 'surface', 'application': 'surface', 'access': 'surface',
  'hcm': 'hcm_flag', 'hcm console': 'hcm_flag', 'console': 'hcm_flag', 'console access': 'hcm_flag',
  'ess': 'ess_flag', 'ess access': 'ess_flag', 'ess app': 'ess_flag', 'mobile': 'ess_flag',
  'password': 'password_value', 'temp password': 'password_value', 'initial password': 'password_value',
  'pin': 'pin_value', 'ess pin': 'pin_value',
  'device': 'device', 'device id': 'device', 'phone': 'phone', 'contact number': 'phone',
  'department': 'department', 'position': 'position', 'notes': 'notes', 'remarks': 'notes',
}));

async function main() {
  const company = process.env.UAT_COMPANY;
  const path = process.argv[2] || '/root/uat-data/User_Accounts_Matrix.xlsx';
  const reportPath = process.argv[3] || '/root/user-accounts-matrix-report.txt';
  if (!company) throw new Error('set UAT_COMPANY');
  if (!fs.existsSync(path)) { console.log(`AWAITING: ${path} not found`); return; }

  const grid = readSheet(path);
  // Header row: first row mapping ≥2 known columns including a name or email.
  let hi = -1, cols = new Map(), unmapped = [];
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const m = new Map(); const um = [];
    grid[i].forEach((h, ix) => {
      const c = MAP.get(normHdr(h));
      if (c && !m.has(c)) m.set(c, ix);
      else if (String(h).trim() && !c) um.push(String(h).trim());
    });
    if (m.size >= 2 && (m.has('name') || m.has('first_name') || m.has('email'))) { hi = i; cols = m; unmapped = um; break; }
  }
  if (hi < 0) {
    const seen = [...new Set(grid.slice(0, 10).flat().map((h) => String(h).trim()).filter(Boolean))];
    console.log(`REFUSED: no recognisable header row. Headers seen: ${seen.join(' | ')}`);
    process.exit(1);
  }

  const g = (row, c) => { const ix = cols.get(c); return ix != null && ix < row.length ? String(row[ix]).trim() : ''; };
  const truthy = (v) => /^(y|yes|true|x|1|✓)$/i.test(String(v).trim());
  const sites = await db.withOwner(async (c) =>
    new Set((await c.query('SELECT name FROM site WHERE company_id=$1', [company])).rows.map((r) => r.name.toUpperCase())));
  const existing = await db.withOwner(async (c) =>
    new Set((await c.query('SELECT lower(email) e FROM app_user WHERE company_id=$1', [company])).rows.map((r) => r.e)));

  const rows = grid.slice(hi + 1).filter((r) => r.some((x) => String(x).trim() !== ''));
  const byRole = new Map(), bySite = new Map();
  const lines = [`user-accounts matrix report — ${path}`, `columns: ${[...cols.keys()].join(', ')}`, ''];
  let withEmail = 0, alreadyProvisioned = 0, both = 0, consoleOnly = 0, essOnly = 0, unclear = 0;
  const flags = new Map();
  const flag = (k) => flags.set(k, (flags.get(k) || 0) + 1);

  rows.forEach((r, i) => {
    const name = g(r, 'name') || [g(r, 'first_name'), g(r, 'middle_name'), g(r, 'surname')].filter(Boolean).join(' ');
    const email = g(r, 'email').toLowerCase();
    const roleRaw = g(r, 'role');
    const role = (roleRaw.match(/R\d{2}/i) || [''])[0].toUpperCase();
    const site = g(r, 'site');
    const surface = g(r, 'surface').toLowerCase();
    const wantsHcm = truthy(g(r, 'hcm_flag')) || /hcm|console|both|all/.test(surface);
    const wantsEss = truthy(g(r, 'ess_flag')) || /ess|mobile|both|all/.test(surface);
    const rowFlags = [];

    if (email) withEmail++;
    if (email && existing.has(email)) { alreadyProvisioned++; rowFlags.push('already provisioned (console account exists)'); }
    if (roleRaw && !role) rowFlags.push(`unrecognised role "${roleRaw}"`);
    if (role && !KNOWN_ROLES.has(role)) rowFlags.push(`unknown role code ${role}`);
    if (role) byRole.set(role || '?', (byRole.get(role) || 0) + 1);
    for (const s of site.split(/[;,/]/).map((x) => x.trim()).filter(Boolean)) {
      bySite.set(s, (bySite.get(s) || 0) + 1);
      // 'All sites' / 'Unscoped' style values are SCOPE descriptors, not site
      // names — report them as scope, never as an unknown-site flag.
      if (/^(all\s*sites?|unscoped|central|company\s*wide|hq)\b/i.test(s)) continue;
      if (!sites.has(s.toUpperCase())) rowFlags.push(`site "${s}" is not one of the canonical six`);
    }
    if (wantsHcm && !email) rowFlags.push('console access requested but NO email (console needs email+password+MFA)');
    // AUTH-SPLIT VIOLATIONS — the constraint that does not change:
    if (cols.has('pin_value') && g(r, 'pin_value') && wantsHcm && !wantsEss)
      rowFlags.push('SPLIT VIOLATION: a PIN specified for a console-only account (PIN is ESS-only)');
    if (cols.has('password_value') && g(r, 'password_value') && wantsEss && !wantsHcm)
      rowFlags.push('SPLIT VIOLATION: a password specified for an ESS-only account (ESS is device+PIN only)');
    if (wantsHcm && wantsEss) { both++; rowFlags.push('BOTH surfaces → needs TWO credentials (console password + ESS device/PIN), never one'); }
    else if (wantsHcm) consoleOnly++;
    else if (wantsEss) essOnly++;
    else { unclear++; rowFlags.push('surface unclear — neither HCM nor ESS marked'); }

    rowFlags.forEach((f) => flag(f.startsWith('SPLIT') ? f : f.replace(/"[^"]*"/g, '"…"')));
    lines.push(`row ${i + 1}: ${name || '(no name)'}${email ? ` <${email}>` : ''} role=${role || roleRaw || '?'} site=${site || '?'}` +
      ` surfaces=${wantsHcm ? 'HCM' : ''}${wantsHcm && wantsEss ? '+' : ''}${wantsEss ? 'ESS' : ''}` +
      (rowFlags.length ? `\n    FLAGS: ${rowFlags.join('; ')}` : ''));
  });

  // Plaintext-credential columns are a finding in themselves (never echoed).
  if (cols.has('password_value')) flag('matrix contains a PASSWORD column — values will NOT be used; system generates credentials');
  if (cols.has('pin_value')) flag('matrix contains a PIN column — values will NOT be used; system generates PINs');

  fs.writeFileSync(reportPath, lines.join('\n') + '\n', { mode: 0o600 });

  console.log(`rows: ${rows.length} · header row ${hi + 1} · with-email ${withEmail} · already-provisioned ${alreadyProvisioned}`);
  console.log(`columns mapped: ${[...cols.keys()].join(', ')}${unmapped.length ? ` · unmapped: ${unmapped.join(' | ')}` : ''}`);
  console.log(`surfaces: both=${both} console-only=${consoleOnly} ess-only=${essOnly} unclear=${unclear}`);
  console.log(`by role: ${[...byRole.entries()].sort().map(([k, n]) => `${k}=${n}`).join(' ') || '(no role column resolved)'}`);
  console.log(`by site: ${[...bySite.entries()].sort().map(([k, n]) => `${k}=${n}`).join(' · ') || '(no site column resolved)'}`);
  for (const [k, n] of [...flags.entries()].sort((a, b) => b[1] - a[1])) console.log(`  FLAG ${String(n).padStart(3)}x ${k}`);
  const distinct = (c) => [...new Set(rows.map((r) => g(r, c)).filter(Boolean))];
  const unknownRoles = distinct('role').filter((v) => !(v.match(/R\d{2}/i)));
  if (unknownRoles.length) console.log(`role values needing a mapping ruling: ${unknownRoles.join(' | ')}`);
  const siteValues = distinct('site');
  if (siteValues.length) console.log(`site/scope values as written: ${siteValues.join(' | ')}`);
  console.log(`per-row detail (names/emails): ${reportPath} (600, on-box only)`);
  console.log('PROVISIONED: NOTHING — awaiting Kira\'s confirmation of the dual-credential plan.');
  await db.close();
}

main().catch((e) => { console.error('[user-matrix] FAILED:', e.message); process.exit(1); });
