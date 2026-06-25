'use strict';
// Deterministic seed fixtures shared by scripts/seed.js and the test suite.
// Plaintext credentials + the TOTP secret live here so tests can authenticate;
// seed.js stores only hashes/secrets in the database.

// One shared TOTP secret keeps tests simple; each user still has MFA enforced.
const MFA_SECRET = 'JBSWY3DPEHPK3PXP';

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

// Employees (A3 confidential fields populated on CAROL).
const EMP = {
  ALICE:  'a0000000-0000-0000-0000-0000000000a1', // R12 admin's employee
  CAROL:  'a0000000-0000-0000-0000-0000000000c1', // confidential-fields subject
  FIELDA: 'a0000000-0000-0000-0000-0000000000f1', // field operator's employee
  TERM:   'a0000000-0000-0000-0000-0000000000e1', // terminated user's employee
  BOB_B:  'b0000000-0000-0000-0000-0000000000b1', // tenant B employee
};

const USERS = {
  ADMIN_A:   { id: 'd0000000-0000-0000-0000-000000000012', company: TENANT_A, employee: EMP.ALICE,  email: 'admin@a.example',   password: 'Admin!Pass12',   role: 'R12', status: 'active' },
  HR_A:      { id: 'd0000000-0000-0000-0000-000000000003', company: TENANT_A, employee: EMP.ALICE,  email: 'hr@a.example',      password: 'HrPass!2026',    role: 'R03', status: 'active' },
  PAYROLL_A: { id: 'd0000000-0000-0000-0000-000000000007', company: TENANT_A, employee: EMP.CAROL,  email: 'pay@a.example',     password: 'PayPass!2026',   role: 'R07', status: 'active' },
  HSE_A:     { id: 'd0000000-0000-0000-0000-000000000006', company: TENANT_A, employee: EMP.CAROL,  email: 'hse@a.example',     password: 'HsePass!2026',   role: 'R06', status: 'active' },
  EMP_A:     { id: 'd0000000-0000-0000-0000-000000000001', company: TENANT_A, employee: EMP.ALICE,  email: 'emp@a.example',     password: 'EmpPass!2026',   role: 'R01', status: 'active' },
  LOCK_A:    { id: 'd0000000-0000-0000-0000-0000000000aa', company: TENANT_A, employee: EMP.ALICE,  email: 'lock@a.example',    password: 'LockPass!2026',  role: 'R01', status: 'active' },
  RESET_A:   { id: 'd0000000-0000-0000-0000-0000000000a5', company: TENANT_A, employee: EMP.ALICE,  email: 'reset@a.example',   password: 'ResetPass!2026', role: 'R01', status: 'active' },
  RESET2_A:  { id: 'd0000000-0000-0000-0000-0000000000a6', company: TENANT_A, employee: EMP.ALICE,  email: 'reset2@a.example',  password: 'Reset2Pass!26',  role: 'R01', status: 'active' },
  FIELD_A:   { id: 'd0000000-0000-0000-0000-0000000000f0', company: TENANT_A, employee: EMP.FIELDA, email: 'field@a.example',   password: 'FieldPass!2026', role: 'R13', status: 'active' },
  TERM_A:    { id: 'd0000000-0000-0000-0000-0000000000e0', company: TENANT_A, employee: EMP.TERM,   email: 'term@a.example',    password: 'TermPass!2026',  role: 'R01', status: 'terminated' },
  BOB_B:     { id: 'd0000000-0000-0000-0000-0000000000b0', company: TENANT_B, employee: EMP.BOB_B,  email: 'bob@b.example',     password: 'BobPass!2026',   role: 'R01', status: 'active' },
};

const DEVICES = {
  FIELD_A: { id: 'c0000000-0000-0000-0000-0000000000f1', company: TENANT_A, employee: EMP.FIELDA, pin: '4815', status: 'active' },
  TERM_A:  { id: 'c0000000-0000-0000-0000-0000000000e1', company: TENANT_A, employee: EMP.TERM,   pin: '1623', status: 'active' },
  B:       { id: 'c0000000-0000-0000-0000-0000000000b1', company: TENANT_B, employee: EMP.BOB_B,  pin: '9999', status: 'active' },
};

const EMPLOYEES = {
  [EMP.ALICE]:  { company: TENANT_A, full_name: 'Alice Admin' },
  [EMP.CAROL]:  { company: TENANT_A, full_name: 'Carol Confidential',
                  pay_grade: 'M3', bank_account: 'NBK-0099-2211',
                  medical_notes: 'Asthma — inhaler on site', permits: 'Confined-space; Hot-work',
                  disciplinary: 'Verbal warning 2025-02 (late)' },
  [EMP.FIELDA]: { company: TENANT_A, full_name: 'Frank Field' },
  [EMP.TERM]:   { company: TENANT_A, full_name: 'Tom Terminated' },
  [EMP.BOB_B]:  { company: TENANT_B, full_name: 'Bob Bravo' },
};

module.exports = { MFA_SECRET, TENANT_A, TENANT_B, EMP, EMPLOYEES, USERS, DEVICES };
