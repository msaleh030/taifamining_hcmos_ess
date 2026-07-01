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
const disciplinary = require('./disciplinary');
const leave = require('./leave');
const liability = require('./liability');
const kpi = require('./kpi');
const attendance = require('./attendance');
const exact = require('./exact');
const docalerts = require('./docalerts');
const support = require('./support');
const policy = require('./policy');
const controls = require('./controls');
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

  // ── F2: Disciplinary action + fan-out. Only permitted issuers (registry
  // allow-set) reach the endpoint; SoD (self / issuer≠checker) is enforced inside.
  { method: 'POST', pattern: /^\/employees\/([0-9a-f-]+)\/disciplinary$/i, allow: 'disciplinary.issuer.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      // Test-only fault injection at the endpoint layer (proves the fan-out
      // transaction rolls back). Disabled in production.
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await disciplinary.issueAction(s,
        { employeeId: m[1], actionType: body.actionType, detail: body.detail, approverUserId: body.approverUserId }, opts) };
    } },

  // ── F3: Leave (self-service) + liability. Liability is pay-adjacent, so it is
  // guarded to the SAME registry set that sees pay (a3.pay.roles) — a role that
  // cannot see pay cannot see liability.
  { method: 'GET', pattern: /^\/leave\/balance$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await leave.balance(s) }) },
  { method: 'POST', pattern: /^\/leave\/apply$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await leave.apply(s, await readJson(req)) }) },
  { method: 'GET', pattern: /^\/liability\/batch\/([0-9a-f-]+)$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await liability.batchLiability(s, m[1]) }) },

  // ── F4: KPI scorecard (role-scoped, feature-flagged) + personal My KPIs. The
  // scorecard is feature-flagged inside the engine (analytics.enabled) — the
  // endpoint returns { enabled:false, cards:[] } when off, never a partial one.
  { method: 'GET', pattern: /^\/kpi\/scorecard$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await kpi.scorecard(s) }) },
  { method: 'GET', pattern: /^\/kpi\/mine$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await kpi.myKpis(s) }) },

  // ── F5: Attendance clock-in (self-service). The server re-validates the
  // location against the employee's site zones; the device verdict is never trusted.
  { method: 'POST', pattern: /^\/attendance\/clock-in$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await attendance.clockIn(s, await readJson(req)) }) },

  // ── F6: Exact payroll integration (upload → schema-validate → reconcile →
  // control-totals → publish). This touches PAY data, so every endpoint is
  // guarded to the pay-visibility role set (a3.pay.roles) — the SAME pay-adjacent
  // discipline as liability: a role that cannot see pay cannot run the upload.
  // Publish has the endpoint-layer fault seam (disabled in production) to prove
  // atomicity; the control-totals mismatch and schema-fail are HARD blocks.
  { method: 'POST', pattern: /^\/exact\/upload$/, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const grid = Array.isArray(body.grid) ? body.grid : exact.parseCsv(String(body.csv || ''));
      return { status: 200, body: await exact.stage(s,
        { period: body.period, filename: body.filename, grid, controlTotals: body.control_totals }) };
    } },
  { method: 'POST', pattern: /^\/exact\/batch\/([0-9a-f-]+)\/reconcile$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await exact.match(s, m[1]) }) },
  { method: 'GET', pattern: /^\/exact\/batch\/([0-9a-f-]+)\/net-check$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await exact.netCheckBatch(s, m[1]) }) },
  { method: 'GET', pattern: /^\/exact\/batch\/([0-9a-f-]+)\/control-totals$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await exact.controlReport(s, m[1]) }) },
  { method: 'POST', pattern: /^\/exact\/batch\/([0-9a-f-]+)\/publish$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && (body.faultStep || body.faultLeg)
        ? { faultStep: body.faultStep, faultLeg: body.faultLeg } : {};
      return { status: 200, body: await exact.publish(s, m[1], opts) };
    } },
  // Scoped retry of the publish fan-out: re-drives only the NON-posted legs (a
  // posted GL leg is never re-attempted → no double-post). Not a re-publish.
  { method: 'POST', pattern: /^\/exact\/batch\/([0-9a-f-]+)\/publish\/retry$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultLeg ? { faultLeg: body.faultLeg } : {};
      return { status: 200, body: await exact.retryPublishLegs(s, m[1], opts) };
    } },
  { method: 'GET', pattern: /^\/exact\/batch\/([0-9a-f-]+)$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await exact.getBatch(s, m[1]) }) },

  // ── F7: Document-expiry alerts (DA-1/DA-2). Guarded to the document-compliance
  // owners (alerts.view.roles) — the DA-2 notified roles + HR/admin oversight;
  // faithful to who OWNS documents, not the broad reports set (R10 has no reports
  // but IS a DA-2 role).
  { method: 'POST', pattern: /^\/alerts\/run$/, allow: 'alerts.view.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await docalerts.runExpiryAlerts(s, (await readJson(req)).asOf) }) },
  { method: 'GET', pattern: /^\/alerts$/, allow: 'alerts.view.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await docalerts.listOpen(s) }) },

  // ── F7: Support tickets. Raise + list + read are self-service (the service
  // record-scopes non-agents to their OWN tickets); driving the lifecycle
  // (transition) is restricted to the support role (support.agent.roles).
  { method: 'POST', pattern: /^\/support\/tickets$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await support.raiseTicket(s, await readJson(req)) }) },
  { method: 'GET', pattern: /^\/support\/tickets$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await support.listTickets(s) }) },
  { method: 'POST', pattern: /^\/support\/tickets\/([0-9a-f-]+)\/transition$/i, allow: 'support.agent.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await support.transition(s, m[1], (await readJson(req)).to) }) },
  { method: 'GET', pattern: /^\/support\/tickets\/([0-9a-f-]+)$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await support.getTicket(s, m[1]) }) },

  // ── F7: Policy acknowledgement (POL-01..04). Read + acknowledge are SELF-
  // SERVICE (every employee). Publishing a company-wide policy is admin
  // (admin.config.write); the outstanding-acks compliance report is reports-only.
  { method: 'GET', pattern: /^\/policy\/([\w-]+)\/outstanding$/i, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.outstanding(s, m[1]) }) },
  { method: 'POST', pattern: /^\/policy\/([\w-]+)\/ack$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.acknowledge(s, m[1]) }) },
  { method: 'GET', pattern: /^\/policy\/([\w-]+)$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.readCurrent(s, m[1]) }) },
  { method: 'POST', pattern: /^\/policy$/, action: 'admin.config.write',
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.publishPolicy(s, await readJson(req)) }) },

  // ── F7: Controls & Checker (AC-AUD-03). The audit/controls view is restricted
  // to the AUD/SOD oversight set (controls.view.roles = R11/R12). Returns per-
  // control checked-counts AND offenders, so the screen can render the all-clear
  // evidence grid (green + counts) distinctly from the fail-with-offenders grid.
  { method: 'GET', pattern: /^\/controls$/, allow: 'controls.view.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await controls.runControls(s) }) },
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
  if (route.allow) {
    const allowed = await cfg.getRoleSet(session.company_id, route.allow, '');
    if (!allowed.has(session.role_code)) throw new HttpError(403, 'forbidden');
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
