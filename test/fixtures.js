'use strict';
// Deterministic seed fixtures shared by scripts/seed.js and the test suite.
// Plaintext credentials + the TOTP secret live here so tests can authenticate;
// seed.js stores only hashes/secrets in the database.

const MFA_SECRET = 'JBSWY3DPEHPK3PXP';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

// Sites (Slice 2). Tenant A: North Mara + Mwadui mines, Head Office, Nyanzaga.
// tenant B one. UUIDs are stable (Slice-2 tests key on SITE.A1/A2).
const SITE = {
  A1: '5170e000-0000-0000-0000-0000000000a1', // North Mara (NM)   — tenant A
  A2: '5170e000-0000-0000-0000-0000000000a2', // Mwadui (MW)        — tenant A
  HO: '5170e000-0000-0000-0000-0000000000d0', // Head Office (HO)   — tenant A
  NZ: '5170e000-0000-0000-0000-0000000000e0', // Nyanzaga (NZ)      — tenant A
  B1: '5170e000-0000-0000-0000-0000000000b1', // tenant B (no zones)
};

const EMP = {
  ALICE:  'a0000000-0000-0000-0000-0000000000a1', // shared by tenant-A console users (SITE A1)
  CAROL:  'a0000000-0000-0000-0000-0000000000c1', // confidential-fields subject (SITE A1)
  FIELDA: 'a0000000-0000-0000-0000-0000000000f1', // field operator (SITE A1)
  TERM:   'a0000000-0000-0000-0000-0000000000e1', // terminated user (SITE A1)
  DAVE:   'a0000000-0000-0000-0000-0000000000d2', // in SITE A2 — out-of-site target
  HOEMP:  'a0000000-0000-0000-0000-0000000000d0', // in SITE HO (no zones)
  BOB_B:  'b0000000-0000-0000-0000-0000000000b1', // tenant B
};

// employee rows. role_code here is the subject's JOB role (directory badge),
// independent of the viewer's session role used for A3.
const EMPLOYEES = {
  [EMP.ALICE]: { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0001', full_name: 'Alice Admin',      role_code: 'R12', dept: 'Admin',      status: 'active', phone: '0700000001', email: 'alice@a.example' },
  [EMP.CAROL]: { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0002', full_name: 'Carol Confidential',role_code: 'R01', dept: 'Processing', status: 'active', phone: '0700000002', email: 'carol@a.example', home_address: '12 Reef Rd' },
  [EMP.FIELDA]:{ company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0003', full_name: 'Frank Field',       role_code: 'R13', dept: 'Mining',     status: 'active', phone: '0700000003', email: 'frank@a.example' },
  [EMP.TERM]:  { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0004', full_name: 'Tom Terminated',    role_code: 'R01', dept: 'Mining',     status: 'terminated', phone: '0700000004', email: 'tom@a.example' },
  [EMP.DAVE]:  { company: TENANT_A, site: SITE.A2, emp_no: 'E-A-0005', full_name: 'Dave SouthSite',    role_code: 'R01', dept: 'Mining',     status: 'active', phone: '0700000005', email: 'dave@a.example' },
  [EMP.HOEMP]: { company: TENANT_A, site: SITE.HO, emp_no: 'E-A-0006', full_name: 'Hettie HeadOffice', role_code: 'R03', dept: 'Admin',      status: 'active', phone: '0700000006', email: 'hettie@a.example' },
  [EMP.BOB_B]: { company: TENANT_B, site: SITE.B1, emp_no: 'E-B-0001', full_name: 'Bob Bravo',         role_code: 'R01', dept: 'Mining',     status: 'active', phone: '0800000001', email: 'bob@b.example' },
};

// Geofence zones (SS-3, registry v1.2) — 7 zones. RADII are confirmed. HO centre
// is CONFIRMED (-6.754188, 39.273797). The mine centres (MW/NM/NZ) are APPROXIMATE
// pending precise survey — flagged; they live here in the registry (never in code)
// so they can be corrected without a deploy. Centres are spaced km apart so a
// small drift cannot fall into a neighbouring zone (keeps tests deterministic).
const GEOFENCE_ZONES = [
  // Head Office — CONFIRMED centre + radius.
  { company: TENANT_A, site: SITE.HO, name: 'HO',               lat: -6.754188, lng: 39.273797, radius: 150 },
  // Mwadui (MW) — radii confirmed, centres approximate.
  { company: TENANT_A, site: SITE.A2, name: 'MW Workshop',      lat: -3.5560, lng: 33.6070, radius: 300 },
  { company: TENANT_A, site: SITE.A2, name: 'MW Production',    lat: -3.5760, lng: 33.6070, radius: 100 }, // ZKTeco non-functional: GPS only
  // North Mara (NM) — radii confirmed, centres approximate.
  { company: TENANT_A, site: SITE.A1, name: 'NM TSF',           lat: -1.4500, lng: 34.4500, radius: 400 },
  { company: TENANT_A, site: SITE.A1, name: 'Gokona Workshop',  lat: -1.4700, lng: 34.4500, radius: 200 },
  { company: TENANT_A, site: SITE.A1, name: 'Gokona Admin',     lat: -1.4500, lng: 34.4700, radius: 100 },
  // Nyanzaga (NZ) — radius confirmed, centre approximate.
  { company: TENANT_A, site: SITE.NZ, name: 'NZ',               lat: -2.7500, lng: 32.5000, radius: 800 },
];

// Confidential rows for CAROL (separate tables).
const PAY = { [EMP.CAROL]: { company: TENANT_A, basic_pay: '4200.00', bank_name: 'NBK', bank_account: 'NBK-0099-2211' } };
const MEDICAL = { [EMP.CAROL]: { company: TENANT_A, osha_status: 'cleared', permit_no: 'CS-1182', permit_expiry: '2026-12-31' } };
const DISCIPLINARY = [
  { company: TENANT_A, employee: EMP.CAROL, kind: 'verbal', detail: 'Late 2025-02', issued_by: 'hr@a.example' },
];
const DOCUMENTS = [
  { company: TENANT_A, employee: EMP.CAROL, kind: 'contract', name: 'Employment contract', valid_until: null, uri: 's3://docs/carol-contract.pdf' },
  { company: TENANT_A, employee: EMP.CAROL, kind: 'permit',   name: 'Confined-space permit', valid_until: '2026-12-31', uri: 's3://docs/carol-permit.pdf' },
];

// Console users. Tenant-A test users point at EMP.ALICE (SITE A1) so a
// site-scoped requester resolves to SITE A1 deterministically.
const USERS = {
  ADMIN_A:    { id: 'd0000000-0000-0000-0000-000000000012', company: TENANT_A, employee: EMP.ALICE, email: 'admin@a.example',    password: 'Admin!Pass12',   role: 'R12', status: 'active' },
  HR_A:       { id: 'd0000000-0000-0000-0000-000000000003', company: TENANT_A, employee: EMP.ALICE, email: 'hr@a.example',       password: 'HrPass!2026',    role: 'R03', status: 'active' }, // maker + checker
  HR2_A:      { id: 'd0000000-0000-0000-0000-000000000004', company: TENANT_A, employee: EMP.ALICE, email: 'hr2@a.example',      password: 'Hr2Pass!2026',   role: 'R04', status: 'active' }, // different checker
  SUP_A:      { id: 'd0000000-0000-0000-0000-000000000002', company: TENANT_A, employee: EMP.ALICE, email: 'sup@a.example',      password: 'SupPass!2026',   role: 'R02', status: 'active' }, // site-scoped maker
  PAYROLL_A:  { id: 'd0000000-0000-0000-0000-000000000007', company: TENANT_A, employee: EMP.ALICE, email: 'pay@a.example',      password: 'PayPass!2026',   role: 'R07', status: 'active' }, // central, pay visible
  DIRECTOR_A: { id: 'd0000000-0000-0000-0000-000000000011', company: TENANT_A, employee: EMP.ALICE, email: 'director@a.example', password: 'DirPass!2026',   role: 'R11', status: 'active' }, // central
  HSE_A:      { id: 'd0000000-0000-0000-0000-000000000006', company: TENANT_A, employee: EMP.ALICE, email: 'hse@a.example',      password: 'HsePass!2026',   role: 'R06', status: 'active' }, // medical+disciplinary
  HSE5_A:     { id: 'd0000000-0000-0000-0000-000000000005', company: TENANT_A, employee: EMP.ALICE, email: 'hse5@a.example',     password: 'Hse5Pass!2026',  role: 'R05', status: 'active' }, // medical (Section 17.1)
  CLINIC_A:   { id: 'd0000000-0000-0000-0000-000000000010', company: TENANT_A, employee: EMP.ALICE, email: 'clinic@a.example',   password: 'ClinPass!2026',  role: 'R10', status: 'active' }, // central medical
  EMP_A:      { id: 'd0000000-0000-0000-0000-000000000001', company: TENANT_A, employee: EMP.ALICE, email: 'emp@a.example',      password: 'EmpPass!2026',   role: 'R01', status: 'active' },
  FIN_A:      { id: 'd0000000-0000-0000-0000-000000000008', company: TENANT_A, employee: EMP.ALICE, email: 'fin@a.example',      password: 'FinPass!2026',   role: 'R08', status: 'active' }, // no directory
  PAYMGR_A:   { id: 'd0000000-0000-0000-0000-000000000009', company: TENANT_A, employee: EMP.ALICE, email: 'paymgr@a.example',   password: 'PmgrPass!2026',  role: 'R09', status: 'active' }, // no directory
  LOCK_A:     { id: 'd0000000-0000-0000-0000-0000000000aa', company: TENANT_A, employee: EMP.ALICE, email: 'lock@a.example',     password: 'LockPass!2026',  role: 'R01', status: 'active' },
  RESET_A:    { id: 'd0000000-0000-0000-0000-0000000000a5', company: TENANT_A, employee: EMP.ALICE, email: 'reset@a.example',    password: 'ResetPass!2026', role: 'R01', status: 'active' },
  RESET2_A:   { id: 'd0000000-0000-0000-0000-0000000000a6', company: TENANT_A, employee: EMP.ALICE, email: 'reset2@a.example',   password: 'Reset2Pass!26',  role: 'R01', status: 'active' },
  FIELD_A:    { id: 'd0000000-0000-0000-0000-0000000000f0', company: TENANT_A, employee: EMP.FIELDA,email: 'field@a.example',    password: 'FieldPass!2026', role: 'R13', status: 'active' },
  SITE2_A:    { id: 'd0000000-0000-0000-0000-0000000000d2', company: TENANT_A, employee: EMP.DAVE,  email: 'dave@a.example',     password: 'DavePass!2026',  role: 'R01', status: 'active' }, // SITE A2 (geofence)
  HO_A:       { id: 'd0000000-0000-0000-0000-0000000000d0', company: TENANT_A, employee: EMP.HOEMP, email: 'hettie@a.example',   password: 'HettiePass!26',  role: 'R03', status: 'active' }, // SITE HO (no zones)
  TERM_A:     { id: 'd0000000-0000-0000-0000-0000000000e0', company: TENANT_A, employee: EMP.TERM,  email: 'term@a.example',     password: 'TermPass!2026',  role: 'R01', status: 'terminated' },
  BOB_B:      { id: 'd0000000-0000-0000-0000-0000000000b0', company: TENANT_B, employee: EMP.BOB_B, email: 'bob@b.example',      password: 'BobPass!2026',   role: 'R01', status: 'active' },
};

const DEVICES = {
  FIELD_A: { id: 'c0000000-0000-0000-0000-0000000000f1', company: TENANT_A, employee: EMP.FIELDA, pin: '4815', status: 'active' },
  TERM_A:  { id: 'c0000000-0000-0000-0000-0000000000e1', company: TENANT_A, employee: EMP.TERM,   pin: '1623', status: 'active' },
  B:       { id: 'c0000000-0000-0000-0000-0000000000b1', company: TENANT_B, employee: EMP.BOB_B,  pin: '9999', status: 'active' },
};

// Bulk directory load for the large-data test (Section 17.5).
const BULK_COUNT = 5200;

// Leave carry (LR-4). With lapse window = 1 year and a 2026 "as of" date: the
// 2024 entry is past its window (lapses), the 2025 entry is still inside it.
const LEAVE_CARRY = [
  { company: TENANT_A, employee: EMP.CAROL, days: 5, year: 2024 }, // should lapse
  { company: TENANT_A, employee: EMP.CAROL, days: 3, year: 2025 }, // should survive
];

module.exports = {
  MFA_SECRET, TENANT_A, TENANT_B, SITE, EMP,
  EMPLOYEES, PAY, MEDICAL, DISCIPLINARY, DOCUMENTS, LEAVE_CARRY, GEOFENCE_ZONES,
  USERS, DEVICES, BULK_COUNT,
};
