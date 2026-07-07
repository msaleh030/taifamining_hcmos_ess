'use strict';
// All primitives from node:crypto — no external packages.
const crypto = require('node:crypto');

// ---- password / PIN hashing (scrypt) --------------------------------------
// Format: scrypt$N$r$p$<saltB64>$<hashB64>
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashSecret(plain) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(plain), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifySecret(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const dk = crypto.scryptSync(String(plain), salt, expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30s) --------------------------------
function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 0xff); }
  }
  return Buffer.from(out);
}

function totpAt(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
            | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

// Verify with a +/-1 step window for clock drift.
function verifyTotp(token, secretB32, atMs = Date.now()) {
  return verifyTotpStep(token, secretB32, atMs) >= 0;
}

// Verify and return the MATCHED counter (>= 0), or -1 on no match. `minStep`
// enforces single-use: a candidate counter must be strictly greater than the
// last-consumed one, so a captured code cannot be replayed within its window.
// The window is [step-1, step] — the current step plus one prior for clock
// drift; a code from the FUTURE (step+1) is never accepted.
function verifyTotpStep(token, secretB32, atMs = Date.now(), minStep = -1) {
  if (!secretB32 || !token) return -1;
  const step = Math.floor(atMs / 1000 / 30);
  const t = Buffer.from(String(token).trim().padStart(6, '0').slice(-6));
  for (const c of [step - 1, step]) {
    if (c <= minStep) continue; // already consumed — replay refused
    if (crypto.timingSafeEqual(Buffer.from(totpAt(secretB32, c)), t)) return c;
  }
  return -1;
}

// A syntactically valid scrypt hash of random bytes, computed once. Verifying a
// password against it always fails but does the SAME scrypt work as a real hash,
// so the login path spends equal time whether or not the account exists — no
// account-enumeration timing oracle.
const DUMMY_HASH = hashSecret(crypto.randomBytes(32).toString('base64'));

// Convenience for seeds/tests: produce the current code for a secret.
function currentTotp(secretB32, atMs = Date.now()) {
  return totpAt(secretB32, Math.floor(atMs / 1000 / 30));
}

// ---- session tokens -------------------------------------------------------
function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function tokenHash(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

module.exports = {
  hashSecret, verifySecret, DUMMY_HASH,
  verifyTotp, verifyTotpStep, currentTotp, base32Decode,
  newToken, tokenHash,
};
