'use strict';
// Shared test harness: boots the real HTTP server on an ephemeral port, talks to
// it over real HTTP (no mocking), and exposes the current TOTP for login.
const { createServer } = require('../src/server');
const db = require('../src/db');
const C = require('../src/crypto');
const F = require('./fixtures');

let server, base;

async function start() {
  if (server) return base;
  server = createServer();
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

async function stop() {
  if (server) await new Promise((res) => server.close(res));
  server = null;
  await db.close();
}

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const mfaNow = () => C.currentTotp(F.MFA_SECRET);

// Convenience console login that returns the token (asserts success).
async function loginConsole(user, overrides = {}) {
  return req('POST', '/auth/console', {
    body: { email: user.email, password: user.password, mfa: mfaNow(), ...overrides },
  });
}

module.exports = { start, stop, req, mfaNow, loginConsole, F };
