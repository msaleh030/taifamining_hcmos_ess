'use strict';
// P1 — field-PIN login screen (Kira 2026-07-14). Two pins:
//   1. BILINGUAL SHIP GATE: every key the field-login screen uses exists in
//      BOTH en.json and sw.json with non-empty values — "P1 ships bilingual or
//      it does not ship". A key added to the screen but not to sw is a failure.
//   2. WIRING: every t('...') key referenced by Login.tsx exists in en.json
//      (no silent raw-key rendering on the first screen 1,099 people see).
// The /auth/field endpoint behaviour itself is pinned by the auth suite and
// test/never_run_wave8.test.js (lockout, resets, revocation).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const en = require('../frontend/src/locales/en.json');
const sw = require('../frontend/src/locales/sw.json');

const FIELD_KEYS = [
  'auth.tabConsole', 'auth.tabField', 'auth.fieldTitle', 'auth.fieldSub', 'auth.pin',
  'auth.fieldSignin', 'auth.fieldHelp', 'auth.errField', 'auth.offField',
  'auth.fieldDevice', 'auth.fieldDeviceChange', 'auth.fieldDeviceEnrol',
  'auth.fieldDeviceEnrolNote', 'auth.fieldDeviceInvalid', 'auth.langToggle',
];

test('P1 bilingual gate: every field-login key exists in BOTH en and sw, non-empty', () => {
  for (const k of FIELD_KEYS) {
    assert.ok(typeof en[k] === 'string' && en[k].trim() !== '', `en missing: ${k}`);
    assert.ok(typeof sw[k] === 'string' && sw[k].trim() !== '', `sw missing: ${k} (P1 ships bilingual or not at all)`);
  }
});

test('P1 wiring: every t() key Login.tsx references exists in en.json', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'src', 'screens', 'Login.tsx'), 'utf8');
  // Bare t('…') calls only — the lookbehind excludes e.g. f.get('email').
  const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 15, `expected a full key set on the screen, found ${used.length}`);
  for (const k of used) assert.ok(k in en, `Login.tsx references a key absent from en.json: ${k}`);
});
