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

// Parse a comma-separated owner role list from config.
async function getOwnerRoles(companyId, key) {
  const v = await getConfig(companyId, key, '');
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { DEFAULT_CONFIG, getConfig, getInt, getOwnerRoles };
