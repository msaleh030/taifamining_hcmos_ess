'use strict';
// HTTP API (Node built-in http only). Routes map 1:1 to the handoff contract.
const http = require('node:http');
const auth = require('./auth');
const employees = require('./employees');
const { HttpError } = require('./errors');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function bearer(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : null;
}

// Require a valid session; throws 401 otherwise.
async function requireSession(req) {
  const session = await auth.verifySession(bearer(req));
  if (!session) throw new HttpError(401, 'authentication required');
  return session;
}

const routes = [
  ['POST', /^\/auth\/console$/, async (req) => ({ status: 200, body: await auth.consoleLogin(await readJson(req)) })],
  ['POST', /^\/auth\/field$/, async (req) => ({ status: 200, body: await auth.fieldLogin(await readJson(req)) })],
  ['POST', /^\/auth\/reset\/password$/, async (req) => {
    const s = await requireSession(req);
    return { status: 200, body: await auth.resetPassword(s, await readJson(req)) };
  }],
  ['POST', /^\/auth\/reset\/pin$/, async (req) => {
    const s = await requireSession(req);
    return { status: 200, body: await auth.resetPin(s, await readJson(req)) };
  }],
  ['GET', /^\/me\/landing$/, async (req) => {
    const s = await requireSession(req);
    return { status: 200, body: auth.landing(s) };
  }],
  ['GET', /^\/me\/profile\/([0-9a-f-]+)$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await auth.readProfile(s, m[1]) };
  }],
  ['POST', /^\/action\/([\w.]+)$/, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await auth.performAction(s, m[1]) };
  }],

  // ── Slice 2: Employee Master ──────────────────────────────────────────────
  ['GET', /^\/employees$/, async (req, _m, url) => {
    const s = await requireSession(req);
    const q = url.searchParams;
    return { status: 200, body: await employees.list(s, {
      q: q.get('q') || undefined, site: q.get('site') || undefined,
      dept: q.get('dept') || undefined, status: q.get('status') || undefined,
      cursor: q.get('cursor') || undefined, limit: q.get('limit') || undefined,
    }) };
  }],
  ['GET', /^\/employees\/([0-9a-f-]+)\/documents$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await employees.documents(s, m[1]) };
  }],
  ['POST', /^\/employees\/([0-9a-f-]+)\/change$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await employees.submitChange(s, m[1], await readJson(req)) };
  }],
  ['GET', /^\/employees\/([0-9a-f-]+)$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await employees.get(s, m[1]) };
  }],
  ['POST', /^\/field-change\/([0-9a-f-]+)\/approve$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await employees.decide(s, m[1], true) };
  }],
  ['POST', /^\/field-change\/([0-9a-f-]+)\/decline$/i, async (req, m) => {
    const s = await requireSession(req);
    return { status: 200, body: await employees.decide(s, m[1], false) };
  }],
];

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      for (const [method, re, handler] of routes) {
        if (req.method !== method) continue;
        const m = re.exec(url.pathname);
        if (!m) continue;
        const out = await handler(req, m, url);
        return send(res, out.status, out.body);
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, e.body);
      // Never leak internals.
      // eslint-disable-next-line no-console
      console.error('[server] unexpected', e);
      send(res, 500, { error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`HCMOS auth API on :${port}`));
}

module.exports = { createServer };
