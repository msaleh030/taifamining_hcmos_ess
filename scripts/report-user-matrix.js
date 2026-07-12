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
// Role NAMES as Taifa writes them -> role codes (the deployed role model:
// R03 HR Officer, R04 HR Manager, R06 SHEQ Manager, R07 Payroll, R11 Head of
// HR, R12 System Administrator, R14 CEO/Executive read-only, R15 Finance
// Manager maker, R16 CFC checker). 'Super Admin' is NOT a matrix-provisionable
// role — it is Kira's interactive on-box step (hidden password) — flagged.
const ROLE_NAMES = new Map(Object.entries({
  'hr officer': 'R03', 'hr manager': 'R04', 'head of hr': 'R11',
  'sheq manager': 'R06', 'sheq': 'R06',
  'payroll officer': 'R07', 'payroll': 'R07',
  'finance manager': 'R15', 'finance manager maker': 'R15',
  'chief financial controller': 'R16', 'chief financial controller checker': 'R16', 'cfc': 'R16',
  'system administrator': 'R12', 'system admin': 'R12',
  'ceo': 'R14', 'ceo executive': 'R14', 'ceo executive read only': 'R14', 'executive': 'R14',
  'supervisor': 'R02', 'employee': 'R01',
}));
const normRole = (v) => String(v || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
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
  const existingRows = await db.withOwner(async (c) =>
    (await c.query('SELECT lower(email) e, role_code FROM app_user WHERE company_id=$1', [company])).rows);
  const existing = new Set(existingRows.map((r) => r.e));
  const existingRole = new Map(existingRows.map((r) => [r.e, r.role_code]));

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
    const role = ((roleRaw.match(/R\d{2}/i) || [])[0] || ROLE_NAMES.get(normRole(roleRaw)) || '').toUpperCase();
    const superAdmin = /super\s*admin/i.test(roleRaw);
    const site = g(r, 'site');
    const surface = g(r, 'surface').toLowerCase();
    const wantsHcm = truthy(g(r, 'hcm_flag')) || /hcm|console|both|all/.test(surface);
    const wantsEss = truthy(g(r, 'ess_flag')) || /ess|mobile|both|all/.test(surface);
    const rowFlags = [];

    if (email) withEmail++;
    if (email && existing.has(email)) {
      alreadyProvisioned++;
      const have = existingRole.get(email);
      rowFlags.push(role && have && have !== role
        ? `ROLE MISMATCH: account exists as ${have} but the matrix says ${role} — Kira ruling needed`
        : 'already provisioned (console account exists, role matches)');
    }
    if (superAdmin) rowFlags.push('SUPER ADMIN: not matrix-provisioned — Kira\'s interactive on-box step (hidden password)');
    else if (roleRaw && !role) rowFlags.push(`unrecognised role "${roleRaw}"`);
    if (role && !KNOWN_ROLES.has(role)) rowFlags.push(`unknown role code ${role}`);
    if (role) byRole.set(role, (byRole.get(role) || 0) + 1);
    else if (superAdmin) byRole.set('SUPER', (byRole.get('SUPER') || 0) + 1);
    for (const s of site.split(/[;,/]/).map((x) => x.trim()).filter(Boolean)) {
      bySite.set(s, (bySite.get(s) || 0) + 1);
      // 'All sites' / 'Unscoped' style values are SCOPE descriptors, not site
      // names — report them as scope, never as an unknown-site flag.
      if (/^(all\s*sites?|unscoped|central|company\s*wide|hq)\b/i.test(s)) continue;
      if (!sites.has(s.toUpperCase())) rowFlags.push(`site "${s}" is not one of the canonical six`);
    }
    // SCOPE MAPPING: 'All sites'/'Unscoped' -> central (valid only for central
    // roles); named canonical sites -> user_site_scope rows; 'one site
    // (confirm)' -> the site is UNNAMED, blocked until named.
    const CENTRAL = new Set(['R04', 'R06', 'R07', 'R11', 'R12', 'R14', 'R15', 'R16']); // R04/R06 central per Kira 2026-07-12
    const scopeCentral = /^(all\s*sites?|unscoped|central|company\s*wide)\b/i.test(site);
    const scopeUnnamed = /confirm|tbc|tbd/i.test(site) || (!site && !scopeCentral);
    if (scopeCentral && role && !CENTRAL.has(role))
      rowFlags.push(`SCOPE MISMATCH: "${site}" (central) on site-bound role ${role} — a site-bound role with org-wide scope breaks the site gate; Kira ruling needed`);
    if (scopeUnnamed && role && !CENTRAL.has(role))
      rowFlags.push('scope not named ("one site (confirm)"/blank) — provisioning blocked until the site is named');
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
