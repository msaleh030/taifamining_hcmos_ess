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
  // Slice 4 — distinct persons so disciplinary SoD is meaningful (all SITE A1).
  DSUBJ:  'a0000000-0000-0000-0000-000000000d51', // disciplinary subject
  DISS:   'a0000000-0000-0000-0000-000000000d52', // issuer
  DCHK:   'a0000000-0000-0000-0000-000000000d53', // checker/approver
  DSUBJ2: 'a0000000-0000-0000-0000-000000000d55', // F2 suspension subject (kept active)
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
  [EMP.DSUBJ]: { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0051', full_name: 'Dan Subject',       role_code: 'R01', dept: 'Mining',     status: 'active', phone: '0700000051', email: 'dan@a.example' },
  [EMP.DISS]:  { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0052', full_name: 'Ivy Issuer',        role_code: 'R05', dept: 'HSE',        status: 'active', phone: '0700000052', email: 'ivy@a.example' },
  [EMP.DCHK]:  { company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0053', full_name: 'Cate Checker',      role_code: 'R04', dept: 'Admin',      status: 'active', phone: '0700000053', email: 'cate@a.example' },
  [EMP.DSUBJ2]:{ company: TENANT_A, site: SITE.A1, emp_no: 'E-A-0055', full_name: 'Devon Subject',     role_code: 'R01', dept: 'Mining',     status: 'active', phone: '0700000055', email: 'devon@a.example' },
  [EMP.BOB_B]: { company: TENANT_B, site: SITE.B1, emp_no: 'E-B-0001', full_name: 'Bob Bravo',         role_code: 'R01', dept: 'Mining',     status: 'active', phone: '0800000001', email: 'bob@b.example' },
};

// Geofence zones (SS-3, registry v1.2, O-1 CLOSED) — 7 zones, all centres and
// radii CONFIRMED. They live here in the registry (never in code) so they can be
// updated without a deploy. NB: NM Gokona Workshop (r200) and Gokona Admin (r100)
// are ~67 m apart (Admin sits inside Workshop) — real survey, so tests that need a
// deterministic single-zone match use the cleanly-separated MW zones.
const GEOFENCE_ZONES = [
  { company: TENANT_A, site: SITE.HO, name: 'HO',              lat: -6.754188, lng: 39.273797, radius: 150 },
  { company: TENANT_A, site: SITE.A2, name: 'MW Workshop',     lat: -3.527972, lng: 33.591528, radius: 300 },
  { company: TENANT_A, site: SITE.A2, name: 'MW Production',   lat: -3.524574, lng: 33.591796, radius: 100 }, // ZKTeco non-functional: GPS only
  { company: TENANT_A, site: SITE.A1, name: 'NM TSF',          lat: -1.478784, lng: 34.504310, radius: 400 },
  { company: TENANT_A, site: SITE.A1, name: 'Gokona Workshop', lat: -1.420831, lng: 34.552759, radius: 200 },
  { company: TENANT_A, site: SITE.A1, name: 'Gokona Admin',    lat: -1.421284, lng: 34.553155, radius: 100 },
  { company: TENANT_A, site: SITE.NZ, name: 'NZ',              lat: -2.938408, lng: 32.679158, radius: 800 },
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
  CEO_A:      { id: 'd0000000-0000-0000-0000-000000000014', company: TENANT_A, employee: EMP.ALICE, email: 'ceo@a.example',      password: 'CeoPass!2026',   role: 'R14', status: 'active' }, // v1.5 CEO/Executive (read-only oversight)
  EMP_A:      { id: 'd0000000-0000-0000-0000-000000000001', company: TENANT_A, employee: EMP.ALICE, email: 'emp@a.example',      password: 'EmpPass!2026',   role: 'R01', status: 'active' },
  CFC_A:      { id: 'd0000000-0000-0000-0000-000000000008', company: TENANT_A, employee: EMP.ALICE, email: 'cfc@a.example',      password: 'CfcPass!2026',   role: 'R16', status: 'active' }, // v1.5 CFC — ingest checker; no directory
  FINMGR_A:   { id: 'd0000000-0000-0000-0000-000000000009', company: TENANT_A, employee: EMP.ALICE, email: 'finmgr@a.example',   password: 'FmgrPass!2026',  role: 'R15', status: 'active' }, // v1.5 Finance Manager — ingest maker; no directory
  LOCK_A:     { id: 'd0000000-0000-0000-0000-0000000000aa', company: TENANT_A, employee: EMP.ALICE, email: 'lock@a.example',     password: 'LockPass!2026',  role: 'R01', status: 'active' },
  RESET_A:    { id: 'd0000000-0000-0000-0000-0000000000a5', company: TENANT_A, employee: EMP.ALICE, email: 'reset@a.example',    password: 'ResetPass!2026', role: 'R01', status: 'active' },
  RESET2_A:   { id: 'd0000000-0000-0000-0000-0000000000a6', company: TENANT_A, employee: EMP.ALICE, email: 'reset2@a.example',   password: 'Reset2Pass!26',  role: 'R01', status: 'active' },
  FIELD_A:    { id: 'd0000000-0000-0000-0000-0000000000f0', company: TENANT_A, employee: EMP.FIELDA,email: 'field@a.example',    password: 'FieldPass!2026', role: 'R13', status: 'active' },
  SITE2_A:    { id: 'd0000000-0000-0000-0000-0000000000d2', company: TENANT_A, employee: EMP.DAVE,  email: 'dave@a.example',     password: 'DavePass!2026',  role: 'R01', status: 'active' }, // SITE A2 (geofence)
  HO_A:       { id: 'd0000000-0000-0000-0000-0000000000d0', company: TENANT_A, employee: EMP.HOEMP, email: 'hettie@a.example',   password: 'HettiePass!26',  role: 'R03', status: 'active' }, // SITE HO (no zones)
  DSUBJ_A:    { id: 'd0000000-0000-0000-0000-000000000d51', company: TENANT_A, employee: EMP.DSUBJ, email: 'dan@a.example',      password: 'DanPass!2026',   role: 'R01', status: 'active' }, // disciplinary subject
  DISS_A:     { id: 'd0000000-0000-0000-0000-000000000d52', company: TENANT_A, employee: EMP.DISS,  email: 'ivy@a.example',      password: 'IvyPass!2026',   role: 'R05', status: 'active' }, // permitted issuer
  DCHK_A:     { id: 'd0000000-0000-0000-0000-000000000d53', company: TENANT_A, employee: EMP.DCHK,  email: 'cate@a.example',     password: 'CatePass!2026',  role: 'R04', status: 'active' }, // permitted checker
  DSUBJ2_A:   { id: 'd0000000-0000-0000-0000-000000000d55', company: TENANT_A, employee: EMP.DSUBJ2, email: 'devon@a.example',   password: 'DevonPass!2026', role: 'R01', status: 'active' }, // F2 suspension subject login
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
  // v1.5: the carry rule keys off the employment anniversary; CAROL has no
  // joined_at, so these rows are INERT under the sweep (test fixtures only).
  { company: TENANT_A, employee: EMP.CAROL, days: 5, year: 2024 },
  { company: TENANT_A, employee: EMP.CAROL, days: 3, year: 2025 },
];

module.exports = {
  MFA_SECRET, TENANT_A, TENANT_B, SITE, EMP,
  EMPLOYEES, PAY, MEDICAL, DISCIPLINARY, DOCUMENTS, LEAVE_CARRY, GEOFENCE_ZONES,
  USERS, DEVICES, BULK_COUNT,
};
