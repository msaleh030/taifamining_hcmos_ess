'use strict';
// ESS device + PIN registration for the confirmed user-accounts matrix (Kira
// A1, 2026-07-12): every matrix person gets a SEPARATE ESS credential — a
// device id + PIN — alongside their console account. TWO credentials, never
// one: the PIN binds to the DEVICE row (auth_lookup_device), the console
// password to app_user; neither opens the other surface (C1 invariant).
//
//   • matrix rows with an email that maps to an app_user WITH an employee
//     record → one device (idempotent: an existing device for that employee
//     is kept, never re-keyed);
//   • the Super Admin row is SKIPPED (Kira's interactive on-box step);
//   • rows without a resolvable email/account are FLAGGED, never guessed;
//   • device ids + PINs go ONLY to the 600-mode credentials file.
//
//   UAT_COMPANY=<uuid> node scripts/provision-ess-devices.js <matrix.xlsx> <credsFile>
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('../src/db');
const C = require('../src/crypto');
const { readSheet, normHdr } = require('./xlsx-to-master');

async function main() {
  const company = process.env.UAT_COMPANY;
  const path = process.argv[2] || '/root/uat-data/Taifa_User_Accounts.xlsx';
  const creds = process.argv[3] || '/root/uat-credentials.txt';
  if (!company) throw new Error('set UAT_COMPANY');
  if (!fs.existsSync(path)) { console.log(`AWAITING: ${path} not found`); return; }

  const grid = readSheet(path);
  let hi = -1, emailIx = -1, roleIx = -1, nameIx = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const m = new Map();
    grid[i].forEach((h, ix) => m.set(normHdr(h), ix));
    const e = m.get('login email') ?? m.get('email') ?? m.get('email id');
    if (e != null && (m.has('full name') || m.has('name'))) {
      hi = i; emailIx = e; roleIx = m.get('role') ?? m.get('role code') ?? -1;
      nameIx = m.get('full name') ?? m.get('name');
      break;
    }
  }
  if (hi < 0) { console.log('REFUSED: no recognisable header row'); process.exit(1); }

  const rows = grid.slice(hi + 1).filter((r) => r.some((x) => String(x).trim() !== ''));
  let created = 0, existing = 0, skippedSuper = 0, flagged = 0;
  const out = [];
  await db.withOwner(async (c) => {
    for (const r of rows) {
      const email = String(r[emailIx] || '').trim().toLowerCase();
      const role = roleIx >= 0 ? String(r[roleIx] || '').trim() : '';
      const name = String(r[nameIx] || '').trim();
      if (/super\s*admin/i.test(role)) { skippedSuper++; continue; } // Kira's interactive step
      if (!email) { flagged++; console.log(`FLAG: row without a login email (name ${name ? 'present' : 'absent'}) — no ESS device without an account`); continue; }
      const u = (await c.query(
        `SELECT id, employee_id FROM app_user WHERE company_id=$1 AND lower(email)=lower($2)`, [company, email])).rows[0];
      if (!u) { flagged++; console.log('FLAG: matrix email has NO console account — provision the console account first (never guessed)'); continue; }
      if (!u.employee_id) { flagged++; console.log('FLAG: account has no employee record — a device binds to an employee'); continue; }
      const d = (await c.query(
        `SELECT id FROM device WHERE company_id=$1 AND employee_id=$2 AND status='active'`, [company, u.employee_id])).rows[0];
      if (d) { existing++; continue; }
      const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const dev = (await c.query(
        `INSERT INTO device(company_id, employee_id, pin_hash, status) VALUES ($1,$2,$3,'active') RETURNING id`,
        [company, u.employee_id, C.hashSecret(pin)])).rows[0];
      out.push(`--- ESS DEVICE (${email})\ndevice_id: ${dev.id}\npin      : ${pin}\n`);
      await c.query('SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8)', [
        company, 'script:provision-ess-devices', 'SYS', 'device.enrolled',
        'device', dev.id, null, { employee_id: u.employee_id, source: 'user-accounts-matrix' }]);
      created++;
    }
  });
  if (out.length) fs.appendFileSync(creds, out.join(''), { mode: 0o600 });
  console.log(`ESS devices: created=${created} existing=${existing} super-skipped=${skippedSuper} flagged=${flagged} (PINs -> ${creds}, 600, on-box only)`);
  await db.close();
}

main().catch((e) => { console.error('[ess-devices] FAILED:', e.message); process.exit(1); });
