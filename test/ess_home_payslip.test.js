'use strict';
// ESS-3 (E2 home completed) + ESS-4 (E6 payslip screen) — frontend pins.
//   • WORDING IS LAW (Kira 2026-07-14): the payslip screen's total reads
//     "Total Pay" and "Net Pay" — the string "Total Allowance" appears in NO
//     locale value the payslip screen uses (the file label is a misnomer).
//   • Both screens render only t() keys, resolved in BOTH languages.
//   • The home quick-action grid carries the payslip tile; Documents /
//     Training / ID card have no backend and are ABSENT (never mocked).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const en = JSON.parse(read('frontend/src/locales/en.json'));
const sw = JSON.parse(read('frontend/src/locales/sw.json'));

test('E6 wording law: Total Pay / Net Pay, never "Total Allowance"', () => {
  assert.equal(en['ess.payslip.totalPay'], 'Total Pay');
  assert.equal(en['ess.payslip.netPay'], 'Net Pay');
  for (const [k, v] of Object.entries(en)) {
    if (k.startsWith('ess.payslip.')) {
      assert.ok(!/total allowance/i.test(String(v)), `${k} must never read "Total Allowance"`);
    }
  }
});

test('payslip + home screens are bilingual: every t() key resolves in EN and SW', () => {
  for (const file of ['frontend/src/screens/Payslip.tsx', 'frontend/src/screens/EssHome.tsx']) {
    const src = read(file);
    const used = [...src.matchAll(/(?<![A-Za-z0-9_.])t\('([a-zA-Z0-9_.]+)'\)/g)].map((m) => m[1]);
    assert.ok(used.length >= 6, `${file} renders through t()`);
    for (const k of used) {
      assert.ok(en[k] !== undefined, `EN missing ${k} (${file})`);
      assert.ok(sw[k] !== undefined, `SW missing ${k} (${file})`);
    }
  }
  for (const k of ['ess.payslip.totalPay', 'ess.payslip.netPay', 'ess.payslip.title']) {
    assert.notEqual(en[k], sw[k], `${k} must actually be translated`);
  }
});

test('E2 home: payslip tile present; no-backend tiles (Documents/Training/ID card) absent, never mocked', () => {
  const src = read('frontend/src/screens/EssHome.tsx');
  assert.match(src, /ess\.qaPayslip/, 'payslip quick-action wired');
  assert.match(src, /\/ess\/payslip/, 'tile routes to the payslip screen');
  assert.ok(!/qaDocs|qaTraining|qaId\b/.test(src.replace(/\/\/.*$/gm, '')),
    'Documents/Training/ID card have no backend — absent from the grid (deferred, not mocked)');
});
