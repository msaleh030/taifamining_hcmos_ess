'use strict';
// HTTP API (Node built-in http only) + static serving for the production frontend.
//
// F0 endpoint MIDDLEWARE: routes are declarative — each declares whether it needs
// a session (auth) and, optionally, an A2 module or an RBAC action. The dispatcher
// enforces session + A2/A3 guards at the HTTP layer BEFORE the handler runs, so
// every per-screen endpoint inherits the guards instead of re-implementing them.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const employees = require('./employees');
const roles = require('./roles');
const cfg = require('./config');
const { HttpError } = require('./errors');

const WEB_DIR = path.join(__dirname, '..', 'web');

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
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return m ? m[1] : null;
}

// ── Declarative routes. auth defaults true; module/action are optional guards. ──
const routes = [
  { method: 'POST', pattern: /^\/auth\/console$/, auth: false,
    handler: async (req) => ({ status: 200, body: await auth.consoleLogin(await readJson(req)) }) },
  { method: 'POST', pattern: /^\/auth\/field$/, auth: false,
    handler: async (req) => ({ status: 200, body: await auth.fieldLogin(await readJson(req)) }) },
  { method: 'POST', pattern: /^\/auth\/reset\/password$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await auth.resetPassword(s, await readJson(req)) }) },
  { method: 'POST', pattern: /^\/auth\/reset\/pin$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await auth.resetPin(s, await readJson(req)) }) },

  { method: 'GET', pattern: /^\/me\/landing$/,
    handler: async (req, m, url, s) => ({ status: 200, body: auth.landing(s) }) },
  { method: 'GET', pattern: /^\/me\/profile\/([0-9a-f-]+)$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await auth.readProfile(s, m[1]) }) },
  { method: 'POST', pattern: /^\/action\/([\w.]+)$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await auth.performAction(s, m[1]) }) },

  // F0: a module-guarded endpoint — proves the A2 guard is enforced at the HTTP
  // layer (roles with the 'reports' module get 200, others 403). Per-screen
  // slices declare their own module/action the same way.
  { method: 'GET', pattern: /^\/reports\/summary$/, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: { role: s.role_code, modules: auth.landing(s).modules, generated: true } }) },

  // ── Slice 2 / F1: Employee Master. The directory access rule is the registry
  // directory.deny.roles set — declared here so the F0 middleware enforces it at
  // the HTTP layer (authoritative); employees.js keeps the same check as cheap
  // defence-in-depth.
  { method: 'GET', pattern: /^\/employees$/, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.list(s, {
      q: url.searchParams.get('q') || undefined, site: url.searchParams.get('site') || undefined,
      dept: url.searchParams.get('dept') || undefined, status: url.searchParams.get('status') || undefined,
      cursor: url.searchParams.get('cursor') || undefined, limit: url.searchParams.get('limit') || undefined,
    }) }) },
  { method: 'GET', pattern: /^\/employees\/([0-9a-f-]+)\/documents$/i, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.documents(s, m[1]) }) },
  { method: 'POST', pattern: /^\/employees\/([0-9a-f-]+)\/change$/i, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.submitChange(s, m[1], await readJson(req)) }) },
  { method: 'GET', pattern: /^\/employees\/([0-9a-f-]+)$/i, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.get(s, m[1]) }) },
  { method: 'POST', pattern: /^\/field-change\/([0-9a-f-]+)\/approve$/i, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.decide(s, m[1], true) }) },
  { method: 'POST', pattern: /^\/field-change\/([0-9a-f-]+)\/decline$/i, deny: 'directory.deny.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await employees.decide(s, m[1], false) }) },
];

// Guard: verify session, then A2 module / RBAC action / registry deny-set if the
// route declares them. `deny` names a registry role-set config key (e.g. the
// directory access rule) — authoritative at the HTTP layer.
async function guard(route, req) {
  if (route.auth === false) return null;
  const session = await auth.verifySession(bearer(req));
  if (!session) throw new HttpError(401, 'authentication required');
  if (route.module && !roles.moduleAllowed(session.role_code, route.module)) throw new HttpError(403, 'forbidden');
  if (route.action && !roles.canPerform(session.role_code, route.action)) throw new HttpError(403, 'forbidden');
  if (route.deny) {
    const denied = await cfg.getRoleSet(session.company_id, route.deny, '');
    if (denied.has(session.role_code)) throw new HttpError(403, 'forbidden');
  }
  return session;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json',
};

// Serve a static asset from web/ (production frontend). Returns true if handled.
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.normalize(path.join(WEB_DIR, rel));
  if (!full.startsWith(WEB_DIR)) return false;         // no path traversal
  const ext = path.extname(full);
  if (!MIME[ext]) return false;                         // whitelisted types only
  let buf;
  try { buf = fs.readFileSync(full); } catch { return false; }
  res.writeHead(200, { 'content-type': MIME[ext] });
  res.end(buf);
  return true;
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      for (const route of routes) {
        if (req.method !== route.method) continue;
        const m = route.pattern.exec(url.pathname);
        if (!m) continue;
        const session = await guard(route, req);
        const out = await route.handler(req, m, url, session);
        return send(res, out.status, out.body);
      }
      // Fall through to the production frontend (static assets).
      if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, e.body);
      // eslint-disable-next-line no-console
      console.error('[server] unexpected', e);
      send(res, 500, { error: 'internal error' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`HCMOS API + frontend on :${port}`));
}

module.exports = { createServer };
