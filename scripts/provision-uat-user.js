'use strict';
// Provision a REAL UAT user — own password + own TOTP enrolment (never the seed's
// shared MFA secret). Creates the person through the application's employee-creation
// path (site-scoped, so a site-bound HR role actually sees the loaded directory),
// then an app_user with a per-user scrypt password hash and a freshly generated
// TOTP secret. Prints the otpauth:// URI for the tester to enrol in their
// authenticator app. Run on the origin box with the deploy env sourced.
//
//   UAT_COMPANY=<tenant uuid> UAT_EMAIL=kira@... UAT_NAME='Kira ...' \
//   UAT_ROLE=R11 UAT_SITE='Head Office' [UAT_PASSWORD=...] \
//     node scripts/provision-uat-user.js
//
// Role guidance: an HR DIRECTOR (R11) is CENTRAL (non-site-scoped) and sees ALL
// sites' directory — best for Kira to see every loaded site. A site-bound HR role
// (R03/R04) sees only its own site, so provision one per loaded site if you want
// scoped testers.
const crypto = require('node:crypto');
const db = require('../src/db');
const C = require('../src/crypto');
const employees = require('../src/employees');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

async function main() {
  const company = process.env.UAT_COMPANY;
  const email = process.env.UAT_EMAIL;
  const name = process.env.UAT_NAME;
  const role = process.env.UAT_ROLE || 'R11';
  const siteName = process.env.UAT_SITE;
  if (!company || !email || !name || !siteName) {
    throw new Error('set UAT_COMPANY, UAT_EMAIL, UAT_NAME, UAT_SITE');
  }
  const password = process.env.UAT_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const secret = base32Encode(crypto.randomBytes(20)); // per-user TOTP secret

  await db.withOwner(async (c) => {
    // Atomic + idempotent: the employee and the uniquely-constrained app_user
    // must land together, or not at all. Without the transaction, a duplicate
    // email (unique on app_user) threw AFTER the employee row committed,
    // leaving an orphan employee. Dup-guard up front, wrap the rest in a tx.
    await c.query('BEGIN');
    try {
      const dup = await c.query(
        'SELECT 1 FROM app_user WHERE company_id=$1 AND lower(email)=lower($2)', [company, email]);
      if (dup.rows.length) throw new Error(`${email} already exists — refusing to create a duplicate`);
      const site = (await c.query('SELECT id FROM site WHERE company_id=$1 AND lower(name)=lower($2)', [company, siteName])).rows[0];
      if (!site) throw new Error(`site "${siteName}" not found in tenant ${company}`);
      const empId = await employees.create(c, company, { full_name: name, site_id: site.id, role_code: role, status: 'active', email });
      const userId = crypto.randomUUID();
      await c.query(
        `INSERT INTO app_user(id,company_id,employee_id,email,password_hash,mfa_secret,role_code,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active')`,
        [userId, company, empId, email, C.hashSecret(password), secret, role]);
      // MULTI-SITE scope (Kira 2026-07-12): UAT_SCOPE_SITES='Site A;Site B'
      // writes the user's visibility SET — each a DISTINCT site, never merged.
      // The employee record stays anchored at UAT_SITE. Every named site must
      // exist (fail-closed: a typo aborts the whole provision, nothing lands).
      const scopeNames = (process.env.UAT_SCOPE_SITES || '').split(';').map((x) => x.trim()).filter(Boolean);
      for (const sn of scopeNames) {
        const sc = (await c.query('SELECT id FROM site WHERE company_id=$1 AND lower(name)=lower($2)', [company, sn])).rows[0];
        if (!sc) throw new Error(`scope site "${sn}" not found — refusing to provision with a broken scope`);
        await c.query(
          `INSERT INTO user_site_scope(company_id, user_id, site_id) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`, [company, userId, sc.id]);
      }
      await c.query('COMMIT');
      if (scopeNames.length) console.log('scope    :', scopeNames.join(' + '), '(multi-site set)');
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }

    const label = encodeURIComponent(`HCMOS UAT:${email}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('HCMOS UAT')}&digits=6&period=30&algorithm=SHA1`;
    /* eslint-disable no-console */
    console.log('\n=== UAT user provisioned ===');
    console.log('email    :', email);
    console.log('password :', process.env.UAT_PASSWORD ? '(as supplied)' : password, '   <-- give to the tester over a secure channel, then rotate');
    console.log('role     :', role, role === 'R11' ? '(Head of HR — central, sees all sites)' : '(site-scoped to ' + siteName + ')');
    console.log('site     :', siteName);
    console.log('TOTP     :', secret, '(base32 — enrol in an authenticator app)');
    console.log('otpauth  :', otpauth);
    console.log('=============================\n');
  });
  await db.close();
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
