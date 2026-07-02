'use strict';
// LI-7 — provision the SUPER ADMIN (System Administrator, R12), UNSCOPED
// (employee_id NULL — no site binding), MFA MANDATORY. NO credential lives in
// config/seed/env/repo: the password is typed interactively at the console
// (hidden — never echoed, never in argv/env/logs) and only its scrypt hash is
// stored. The TOTP secret is generated fresh and shown ONCE as an otpauth URI
// for enrolment. There is no hardcoded admin login anywhere.
//
//   UAT_COMPANY=<tenant uuid> node scripts/provision-super-admin.js [email]
//   (email defaults to mohammed@railgrid.tz)
const crypto = require('node:crypto');
const readline = require('node:readline');
const db = require('../src/db');
const C = require('../src/crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

async function provisionSuperAdmin({ company, email, password }) {
  if (!company || !email) throw new Error('company and email required');
  if (!password || String(password).length < 12) throw new Error('password must be at least 12 characters');
  const secret = base32Encode(crypto.randomBytes(20)); // per-user TOTP — MFA mandatory at login
  const userId = crypto.randomUUID();
  await db.withOwner(async (c) => {
    const dup = await c.query('SELECT 1 FROM app_user WHERE company_id=$1 AND email=$2', [company, email]);
    if (dup.rows.length) throw new Error(`${email} already exists — refusing to overwrite (no silent admin reset)`);
    await c.query(
      `INSERT INTO app_user(id, company_id, employee_id, email, password_hash, mfa_secret, role_code, status)
       VALUES ($1,$2,NULL,$3,$4,$5,'R12','active')`,
      [userId, company, email, C.hashSecret(password), secret]);
  });
  const label = encodeURIComponent(`HCMOS:${email}`);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('HCMOS')}&digits=6&period=30&algorithm=SHA1`;
  return { user_id: userId, email, role: 'R12', otpauth, secret };
}

// Hidden prompt: the question is shown, keystrokes are not echoed.
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const orig = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (s.includes(question)) orig(s); };
    rl.question(question, (ans) => { process.stdout.write('\n'); rl.close(); resolve(ans); });
  });
}

async function main() {
  const email = process.argv[2] || 'mohammed@railgrid.tz';
  const company = process.env.UAT_COMPANY || process.env.SUPERADMIN_COMPANY;
  if (!company) { console.error('set UAT_COMPANY=<tenant uuid>'); process.exit(2); }
  const p1 = await promptHidden(`Super-admin password for ${email} (hidden, min 12 chars): `);
  const p2 = await promptHidden('Repeat password: ');
  if (p1 !== p2) { console.error('passwords do not match — nothing provisioned'); process.exit(1); }
  const res = await provisionSuperAdmin({ company, email, password: p1 });
  console.log('\n=== SUPER ADMIN provisioned (LI-7) ===');
  console.log('email  :', res.email, '— R12 System Administrator, UNSCOPED, MFA mandatory');
  console.log('TOTP   : enrol in your authenticator NOW (shown once):');
  console.log('        ', res.otpauth);
  console.log('password: not stored, not printed — scrypt hash only.');
  await db.close();
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { provisionSuperAdmin };
