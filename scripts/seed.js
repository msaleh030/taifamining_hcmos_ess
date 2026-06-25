#!/usr/bin/env node
'use strict';
// Idempotent seed run as the owner role (bypasses RLS). Inserts two tenants and
// the users/devices/employees/config the suite relies on. Passwords and PINs are
// stored only as scrypt hashes; the TOTP secret is stored as-is (it is a secret
// per user). Plaintext lives only in test/fixtures.js for the tests.
const db = require('../src/db');
const C = require('../src/crypto');
const { DEFAULT_CONFIG } = require('../src/config');
const F = require('../test/fixtures');

async function main() {
  await db.withOwner(async (c) => {
    // Clean slate (FK-safe order). schema.sql also drops; this lets `npm run seed`
    // run standalone without a fresh migrate.
    for (const t of ['idempotency', 'session', 'audit', 'device', 'app_user', 'employee', 'config', 'tenant']) {
      await c.query(`DELETE FROM ${t}`);
    }

    await c.query('INSERT INTO tenant(company_id,name,status) VALUES ($1,$2,$3),($4,$5,$6)',
      [F.TENANT_A, 'Tenant A', 'active', F.TENANT_B, 'Tenant B', 'active']);

    // Per-tenant config (lockout policy, owners, ttls).
    for (const company of [F.TENANT_A, F.TENANT_B]) {
      for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        await c.query('INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)', [company, key, value]);
      }
    }

    for (const [id, e] of Object.entries(F.EMPLOYEES)) {
      await c.query(
        `INSERT INTO employee(id,company_id,full_name,pay_grade,bank_account,medical_notes,permits,disciplinary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, e.company, e.full_name, e.pay_grade || null, e.bank_account || null,
         e.medical_notes || null, e.permits || null, e.disciplinary || null]);
    }

    for (const u of Object.values(F.USERS)) {
      await c.query(
        `INSERT INTO app_user(id,company_id,employee_id,email,password_hash,mfa_secret,role_code,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.company, u.employee, u.email, C.hashSecret(u.password), F.MFA_SECRET, u.role, u.status]);
    }

    for (const d of Object.values(F.DEVICES)) {
      await c.query(
        `INSERT INTO device(id,company_id,employee_id,pin_hash,status)
         VALUES ($1,$2,$3,$4,$5)`,
        [d.id, d.company, d.employee, C.hashSecret(d.pin), d.status]);
    }
  });
  await db.close();
  console.log('[seed] done');
}

main().catch((e) => { console.error('[seed] failed', e); process.exit(1); });
