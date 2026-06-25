'use strict';
// Runtime configuration lives in the `config` table, per tenant — NEVER in code.
// These are the DEFAULT values seeded for a tenant. The [TBC] items (lockout
// policy, enrolment/PIN-reset owners) are pending the 4 July governance return;
// they are read from `config` at request time so they can change without a
// deploy. The values here are defensible defaults, not hard-coded policy.
const { query } = require('./db');

const DEFAULT_CONFIG = {
  // [TBC] auth lockout policy
  'auth.lockout.threshold': '5',     // failed attempts before lock
  'auth.lockout.duration':  '900',   // lock seconds (15 min)

  // session lifetime
  'session.ttl':            '3600',  // console session seconds (1 h)
  'session.field.ttl':      '43200', // field/kiosk session seconds (12 h shift)

  // [TBC] permitted owners for credential operations (role lists)
  'password.reset.owner':       'R03,R12', // HR Officer, System Admin
  'pin.reset.owner':            'R03,R12', // [TBC] device-enrolment/PIN owner
  'device.reenrolment.owner':   'R12',     // [TBC] new phone / replaced kiosk

  // default role for a field session when the device's employee has no app_user
  'field.default.role':     'R13',

  // ── Slice 2: Employee Master ──────────────────────────────────────────────
  // A3 confidential-field visibility (role lists). [TBC] 4 July: +R08 pay, +R11
  // medical — kept OUT by default (conservative least privilege), flip in config.
  'a3.pay.roles':          'R07,R09,R11',
  'a3.medical.roles':      'R05,R06,R10',
  'a3.disciplinary.roles': 'R05,R06,R07,R11',

  // Roles with NO directory access at all (server returns 403 on /employees*).
  'directory.deny.roles':  'R08,R09,R12,R13',

  // Maker-checker: who may propose / approve a change, per editable field.
  // Generic fallback applies when a field-specific key is absent.
  'field_change.makers':         'R02,R03,R04',
  'field_change.checkers':       'R03,R04,R11',
  'field_change.makers.phone':   'R02,R03,R04',
  'field_change.checkers.phone': 'R03,R04,R11',

  // Directory paging — server-side bound; first page must not full-table scan.
  'employees.page_size':   '50',
  'employees.page_max':    '200',
};

// Site-scope is data/config (the site_scope table), not hard-coded. These are
// the seeded defaults. [TBC] site_scope.R05 — HSE is site-based in mining, so
// scoped=true by decision; flip in the table if governance says central.
const SITE_SCOPE = {
  R01: true,  R02: true,  R03: true,  R04: true,  R05: true,  R06: true,
  R07: false, R08: false, R09: false, R10: false, R11: false, R12: false, R13: false,
};

// Cached per-tenant reads are unnecessary here; config_get is a cheap indexed
// lookup via a SECURITY DEFINER function (bootstrap-safe, no app.company_id needed).
async function getConfig(companyId, key, fallback = null) {
  const r = await query('SELECT config_get($1,$2) AS v', [companyId, key]);
  const v = r.rows[0] && r.rows[0].v;
  return v === null || v === undefined ? fallback : v;
}

async function getInt(companyId, key, fallback) {
  const v = await getConfig(companyId, key, null);
  return v === null ? fallback : parseInt(v, 10);
}

// Parse a comma-separated role list from config.
async function getOwnerRoles(companyId, key) {
  const v = await getConfig(companyId, key, '');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// Comma-separated config as a Set, with a code fallback if the key is unset.
async function getRoleSet(companyId, key, fallbackCsv = '') {
  const v = await getConfig(companyId, key, null);
  const csv = v === null ? fallbackCsv : v;
  return new Set(csv.split(',').map((s) => s.trim()).filter(Boolean));
}

module.exports = { DEFAULT_CONFIG, SITE_SCOPE, getConfig, getInt, getOwnerRoles, getRoleSet };
