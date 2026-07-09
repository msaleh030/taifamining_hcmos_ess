#!/usr/bin/env node
'use strict';
// Idempotent seed run as the owner role (bypasses RLS). Loads Slice 1 + Slice 2
// fixtures and a bulk directory (5,200 employees) for the large-data test.
// Passwords/PINs are stored only as scrypt hashes; the TOTP secret is per user.
const db = require('../src/db');
const C = require('../src/crypto');
const { DEFAULT_CONFIG, SITE_SCOPE } = require('../src/config');
const exactContract = require('../src/exact_contract');
const F = require('../test/fixtures');

async function main() {
  await db.withOwner(async (c) => {
    // Clean slate (FK-safe order). audit is append-only (DELETE is blocked by a
    // trigger), so TRUNCATE it — which also resets the chain to genesis.
    await c.query('TRUNCATE audit RESTART IDENTITY');
    for (const t of ['idempotency', 'exact_row', 'exact_batch', 'ingest_row', 'ingest_batch',
      'notification', 'activity_feed',
      'attendance', 'doc_alert', 'support_ticket', 'policy_ack', 'policy', 'leave_request',
      'field_change', 'leave_carry_sweep', 'leave_carry', 'geofence_zone', 'employee_document', 'employee_asset',
      'disciplinary', 'employee_medical', 'employee_pay', 'session', 'empno_counter', 'device',
      'app_user', 'employee', 'site', 'config', 'site_scope', 'exact_column', 'tenant']) {
      await c.query(`DELETE FROM ${t}`);
    }

    // Exact column contract (reference data, versioned; seeded once, not per-tenant).
    for (const col of exactContract.build()) {
      await c.query('INSERT INTO exact_column(version,position,section,header,pinned) VALUES ($1,$2,$3,$4,$5)',
        [col.version, col.position, col.section, col.header, col.pinned]);
    }

    await c.query('INSERT INTO tenant(company_id,name,status) VALUES ($1,$2,$3),($4,$5,$6)',
      [F.TENANT_A, 'Tenant A', 'active', F.TENANT_B, 'Tenant B', 'active']);

    // Global role config: which roles are site-scoped.
    for (const [role, scoped] of Object.entries(SITE_SCOPE)) {
      await c.query('INSERT INTO site_scope(role_code,scoped) VALUES ($1,$2)', [role, scoped]);
    }

    for (const company of [F.TENANT_A, F.TENANT_B]) {
      for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        await c.query('INSERT INTO config(company_id,key,value) VALUES ($1,$2,$3)', [company, key, value]);
      }
    }

    await c.query(
      'INSERT INTO site(id,company_id,name) VALUES ($1,$2,$3),($4,$5,$6),($7,$8,$9),($10,$11,$12),($13,$14,$15)',
      [F.SITE.A1, F.TENANT_A, 'North Mara', F.SITE.A2, F.TENANT_A, 'Mwadui',
       F.SITE.HO, F.TENANT_A, 'Head Office', F.SITE.NZ, F.TENANT_A, 'Nyanzaga',
       F.SITE.B1, F.TENANT_B, 'B Site']);

    for (const z of F.GEOFENCE_ZONES) {
      await c.query(
        'INSERT INTO geofence_zone(company_id,site_id,name,center_lat,center_lng,radius_m) VALUES ($1,$2,$3,$4,$5,$6)',
        [z.company, z.site, z.name, z.lat, z.lng, z.radius]);
    }

    for (const [id, e] of Object.entries(F.EMPLOYEES)) {
      // Seeded employees are pre-go-live: their number is retained as legacy_id
      // (EN-6), which grandfathers it past the new TMCL format constraint.
      await c.query(
        `INSERT INTO employee(id,company_id,site_id,emp_no,legacy_id,full_name,role_code,dept,status,phone,email,home_address)
         VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, e.company, e.site, e.emp_no, e.full_name, e.role_code, e.dept, e.status,
         e.phone || null, e.email || null, e.home_address || null]);
    }

    // Site line managers (Slice 4 — resolved into disciplinary notifications/audit).
    for (const [siteId, mgr] of [[F.SITE.A1, F.EMP.ALICE], [F.SITE.A2, F.EMP.DAVE],
      [F.SITE.HO, F.EMP.HOEMP], [F.SITE.B1, F.EMP.BOB_B]]) {
      await c.query('UPDATE site SET manager_employee_id=$1 WHERE id=$2', [mgr, siteId]);
    }

    for (const [empId, p] of Object.entries(F.PAY)) {
      await c.query('INSERT INTO employee_pay(employee_id,company_id,basic_pay,bank_name,bank_account) VALUES ($1,$2,$3,$4,$5)',
        [empId, p.company, p.basic_pay, p.bank_name, p.bank_account]);
    }
    for (const [empId, m] of Object.entries(F.MEDICAL)) {
      await c.query('INSERT INTO employee_medical(employee_id,company_id,osha_status,permit_no,permit_expiry) VALUES ($1,$2,$3,$4,$5)',
        [empId, m.company, m.osha_status, m.permit_no, m.permit_expiry]);
    }
    for (const d of F.DISCIPLINARY) {
      await c.query('INSERT INTO disciplinary(company_id,employee_id,kind,detail,issued_by) VALUES ($1,$2,$3,$4,$5)',
        [d.company, d.employee, d.kind, d.detail, d.issued_by]);
    }
    for (const d of F.DOCUMENTS) {
      await c.query('INSERT INTO employee_document(company_id,employee_id,kind,name,valid_until,uri) VALUES ($1,$2,$3,$4,$5,$6)',
        [d.company, d.employee, d.kind, d.name, d.valid_until, d.uri]);
    }

    // Leave carry (LR-4): one entry old enough to lapse under a 1-year window and
    // one still inside it (asserted by test/leave.test.js with asOf in 2026).
    for (const lc of F.LEAVE_CARRY) {
      await c.query('INSERT INTO leave_carry(company_id,employee_id,days,carried_for_year) VALUES ($1,$2,$3,$4)',
        [lc.company, lc.employee, lc.days, lc.year]);
    }

    for (const u of Object.values(F.USERS)) {
      await c.query(
        `INSERT INTO app_user(id,company_id,employee_id,email,password_hash,mfa_secret,role_code,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.id, u.company, u.employee, u.email, C.hashSecret(u.password), F.MFA_SECRET, u.role, u.status]);
    }

    for (const d of Object.values(F.DEVICES)) {
      await c.query('INSERT INTO device(id,company_id,employee_id,pin_hash,status) VALUES ($1,$2,$3,$4,$5)',
        [d.id, d.company, d.employee, C.hashSecret(d.pin), d.status]);
    }

    // Bulk directory load — one statement (fast). Spread across the two tenant-A
    // sites; a few non-active lifecycle states so the directory still lists them.
    await c.query(
      `INSERT INTO employee(company_id, site_id, emp_no, legacy_id, full_name, role_code, dept, status, phone, email, joined_at)
       SELECT $1,
              CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
              'E'||lpad(g::text,5,'0'),
              'E'||lpad(g::text,5,'0'),
              'Emp '||lpad(g::text,5,'0'),
              'R01',
              (ARRAY['Mining','Processing','HSE','Admin','Logistics'])[1 + g % 5],
              (ARRAY['active','active','active','active','active','active','active','suspended','terminated','rehire'])[1 + g % 10],
              '07'||lpad(g::text,8,'0'),
              'emp'||g||'@a.example',
              date '2020-01-01' + (g % 1500)
       FROM generate_series(1,$4) g`,
      [F.TENANT_A, F.SITE.A1, F.SITE.A2, F.BULK_COUNT]);
  });
  await db.close();
  console.log('[seed] done');
}

main().catch((e) => { console.error('[seed] failed', e); process.exit(1); });
