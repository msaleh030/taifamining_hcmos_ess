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
const kiosk = require('./kiosk');
const exact = require('./exact');
const docalerts = require('./docalerts');
const support = require('./support');
const policy = require('./policy');
const controls = require('./controls');
const audit = require('./audit');
const provision = require('./provision');
const reports = require('./reports');
const ingest = require('./ingest');
const payslip = require('./payslip');
const db = require('./db');
const crypto = require('node:crypto');
const roles = require('./roles');
const cfg = require('./config');
const { HttpError } = require('./errors');

const WEB_DIR = path.join(__dirname, '..', 'web');
// The DESIGNED frontend (frontend/dist, built by Vite in CI/deploy). When the
// build exists it serves as the root app and the vanilla scaffold retires to
// /legacy (kept as the functional preview until every screen is baseline-
// accepted); without a build, behaviour is unchanged (scaffold at root).
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
// The code version this PROCESS is serving (see the /health route note).
let BUILD = null;
try { BUILD = fs.readFileSync(path.join(__dirname, '..', 'BUILD_SHA'), 'utf8').trim().slice(0, 12) || null; } catch { /* unstamped */ }

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

// The real client IP behind the Cloudflare tunnel: cloudflared connects from
// loopback, so req.socket.remoteAddress is 127.0.0.1; the true origin is in the
// CF-Connecting-IP header (fall back to the first X-Forwarded-For hop, then the
// socket). Recorded on auth.signin for forensics; never used for authorization.
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).slice(0, 64);
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim().slice(0, 64);
  return (req.socket && req.socket.remoteAddress) ? String(req.socket.remoteAddress).slice(0, 64) : null;
}

// ── Declarative routes. auth defaults true; module/action are optional guards. ──
const routes = [
  // Liveness/readiness for systemd, the smoke test and edge monitoring. Public,
  // returns NO data beyond ok/db/build — safe to expose. `build` is read ONCE at
  // process start (BUILD_SHA is stamped into the deploy tarball), so it reports
  // the code the RUNNING process serves — a redeploy that updated the disk but
  // not the process shows the stale value here, which is exactly the signal the
  // deploy's staleness checkpoint needs. Absent stamp (sandbox/dev) → null.
  { method: 'GET', pattern: /^\/health$/, auth: false,
    handler: async () => { await db.query('SELECT 1'); return { status: 200, body: { ok: true, db: true, build: BUILD } }; } },

  // Public login config — the login UI reads it to show/hide the MFA field.
  // Same key that gates enforcement, so field + enforcement never disagree.
  { method: 'GET', pattern: /^\/auth\/config$/, auth: false,
    handler: async () => ({ status: 200, body: await auth.publicAuthConfig() }) },
  { method: 'POST', pattern: /^\/auth\/console$/, auth: false,
    handler: async (req) => ({ status: 200, body: await auth.consoleLogin(await readJson(req), { source_ip: clientIp(req) }) }) },
  { method: 'POST', pattern: /^\/auth\/field$/, auth: false,
    handler: async (req) => ({ status: 200, body: await auth.fieldLogin(await readJson(req)) }) },
  // ── Shared KIOSK (Kira 2026-07-14): site-enrolled device, PIN identifies the
  // person, session is clock-only + single-use. Pre-auth surface is gated on
  // possession of an enrolled ACTIVE kiosk device id (generic 401 otherwise).
  { method: 'POST', pattern: /^\/kiosk\/roster$/, auth: false,
    handler: async (req) => ({ status: 200, body: await kiosk.roster(await readJson(req)) }) },
  { method: 'POST', pattern: /^\/auth\/kiosk$/, auth: false,
    handler: async (req) => ({ status: 200, body: await kiosk.kioskLogin(await readJson(req)) }) },
  { method: 'POST', pattern: /^\/kiosk\/punch$/, kioskOk: true,
    handler: async (req, m, url, s) => ({ status: 200, body: await kiosk.punch(s, await readJson(req)) }) },
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

  // ── E6: ESS payslip (PRT-02) — OWN pay only, published back by the Exact ESS
  // leg (C18). Auth-only like the other self-service routes: there is no
  // employee parameter, so the guard surface is the session itself; a3.pay.roles
  // still gates everyone ELSE's pay everywhere else (untouched).
  { method: 'GET', pattern: /^\/me\/payslips$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await payslip.listOwn(s) }) },
  { method: 'GET', pattern: /^\/me\/payslip$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await payslip.getOwn(s, url.searchParams.get('batch')) }) },

  // F0: a module-guarded endpoint — proves the A2 guard is enforced at the HTTP
  // layer (roles with the 'reports' module get 200, others 403). Per-screen
  // slices declare their own module/action the same way. This handler returns NO
  // financial data — only the role/module context.
  //
  // C16/C17 GUARD RULE: the 'reports' module is broader than pay-visibility
  // (R02/R04/R06/R12/R14 hold 'reports' but are NOT in a3.pay.roles). Any
  // report that emits the Payroll or Leave-liability REGISTER must therefore carry
  // allow:'a3.pay.roles' (like /liability/batch/:id) — module:'reports' ALONE is
  // NOT a sufficient gate for a financial register. Enforced/regression-pinned in
  // test/f3.test.js (a reports/payroll-module role without pay-visibility → 403).
  { method: 'GET', pattern: /^\/reports\/summary$/, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: { role: s.role_code, modules: auth.landing(s).modules, generated: true } }) },

  // C17 Reports catalogue — any reports-module role sees it, but the FINANCIAL
  // registers are listed only to pay-visibility roles (server filters).
  { method: 'GET', pattern: /^\/reports\/catalogue$/, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: await reports.catalogue(s) }) },
  // Organogram — positional by design (titles, Kira ruling): directory-tier data
  // only, site-scoped through the shared gate inside the service.
  { method: 'GET', pattern: /^\/reports\/organogram$/, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: await reports.organogram(s) }) },
  // The Payroll + Leave-liability REGISTERS carry the C16 financial gate
  // (a3.pay.roles), NOT module:'reports' — a report inherits the gate of its data.
  // A reports-module role that is not pay-visibility is 403 here, server-side.
  { method: 'GET', pattern: /^\/reports\/register\/payroll\/([0-9a-f-]+)$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await reports.payrollRegister(s, m[1]) }) },
  { method: 'GET', pattern: /^\/reports\/register\/leave-liability\/([0-9a-f-]+)$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await reports.leaveLiabilityRegister(s, m[1]) }) },

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
  // Expatriate field-change decision: MAKER = R03 (site HR), CHECKER = R11 (Head
  // of HR) — expat.checker.roles. Kira 2026-07-14: the CEO (R14) is read-only
  // EVERYWHERE, no exceptions — the former readonlyOk carve-out is removed, so
  // R14 (auth.readonly.roles) is barred here like every other mutating route.
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
  // ── C10: approval queue + decision (LV-03) — RBAC action leave.approve
  // (R02/R04/R11). SOD-01 same-user-403 and site scoping are enforced in the
  // service; LR-6 coverage is warn-not-block with the UNI-06 audited override.
  { method: 'GET', pattern: /^\/leave\/requests$/, action: 'leave.approve',
    handler: async (req, m, url, s) => ({ status: 200, body: await leave.queue(s) }) },
  { method: 'POST', pattern: /^\/leave\/requests\/([0-9a-f-]+)\/decide$/i, action: 'leave.approve',
    handler: async (req, m, url, s) => ({ status: 200, body: await leave.decide(s, m[1], await readJson(req)) }) },
  { method: 'GET', pattern: /^\/liability\/batch\/([0-9a-f-]+)$/i, allow: 'a3.pay.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await liability.batchLiability(s, m[1]) }) },
  // Kira 2026-07-14: the terminal/severance-dues surface is PARKED — removed from
  // the production HTTP surface (a severance calculation carries statutory
  // exposure and was never in Taifa's scope). src/terminal.js and its tests stay
  // on the branch; the route is not registered, so it is unreachable in prod.

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
  // ESS-5 (AC-ATT-02): shift close — same trust boundary as clock-in.
  { method: 'POST', pattern: /^\/attendance\/clock-out$/,
    handler: async (req, m, url, s) => ({ status: 200, body: await attendance.clockOut(s, await readJson(req)) }) },

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
  // faithful to who OWNS documents, not the broad reports set (R03 has no reports
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
  // SERVICE (every employee). Publishing a company-wide policy is guarded to the
  // registry role-set policy.publish.roles (so the owner is UAT-flippable via
  // config, not code); the outstanding-acks compliance report is reports-only.
  { method: 'GET', pattern: /^\/policy\/([\w-]+)\/outstanding$/i, module: 'reports',
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.outstanding(s, m[1]) }) },
  { method: 'POST', pattern: /^\/policy\/([\w-]+)\/ack$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.acknowledge(s, m[1]) }) },
  { method: 'GET', pattern: /^\/policy\/([\w-]+)$/i,
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.readCurrent(s, m[1]) }) },
  { method: 'POST', pattern: /^\/policy$/, allow: 'policy.publish.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await policy.publishPolicy(s, await readJson(req)) }) },

  // ── F7: Controls & Checker (AC-AUD-03). The audit/controls view is restricted
  // to the AUD/SOD oversight set (controls.view.roles = R11/R12). Returns per-
  // control checked-counts AND offenders, so the screen can render the all-clear
  // evidence grid (green + counts) distinctly from the fail-with-offenders grid.
  { method: 'GET', pattern: /^\/controls$/, allow: 'controls.view.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await controls.runControls(s) }) },

  // ── Wave 9: audit read surface (AC-AUD-01). Strictly read-only window over the
  // tamper-evident chain for the SAME oversight set (controls.view.roles =
  // R11/R12). Newest-first, paged (?limit, ?before=<seq>), filterable by
  // ?action / ?entity / ?actor / ?entity_id. Read-only, so the Wave-5 read-only
  // guard is a no-op here (GET), and it is not self-audited.
  { method: 'GET', pattern: /^\/audit$/, allow: 'controls.view.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await audit.list(s, Object.fromEntries(url.searchParams)) }) },

  // ── F8: Tenant provisioning wizard (C21, TEN-01/02/03). The highest-privilege
  // action — restricted to the platform admin role (action admin.tenant.manage =
  // R12). The companyId is MINTED server-side (crypto.randomUUID), so a caller
  // cannot target an existing tenant; provisioning only ever creates a fresh,
  // RLS-isolated company. The provision is one owner transaction — a mid-provision
  // fault (NODE_ENV seam) rolls the whole tenant back (nothing half-created).
  { method: 'POST', pattern: /^\/tenants$/, action: 'admin.tenant.manage',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await provision.provisionTenant(
        { companyId: crypto.randomUUID(), name: body.name, actor: String(s.user_id || 'system'), role: s.role_code || 'SYS' }, opts) };
    } },

  // ── Opening-Balance & Document Ingestion (maker-checker, atomic, dry-run).
  // Highest-privilege load path — guarded to the high-authority set (ingest.roles).
  // preview = dry-run (writes nothing); commit = SUBMIT (maker, no batch_id) then
  // APPROVE (checker, batch_id — must be a DIFFERENT user). NODE_ENV fault seam.
  { method: 'POST', pattern: /^\/ingest\/opening-balance\/preview$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await ingest.preview(s, 'opening_balance', await readJson(req)) }) },
  { method: 'POST', pattern: /^\/ingest\/opening-balance\/commit$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await ingest.commit(s, 'opening_balance', body, opts) };
    } },
  { method: 'POST', pattern: /^\/ingest\/permits\/preview$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await ingest.preview(s, 'permit', await readJson(req)) }) },
  { method: 'POST', pattern: /^\/ingest\/permits\/commit$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await ingest.commit(s, 'permit', body, opts) };
    } },
  { method: 'POST', pattern: /^\/ingest\/employee-master\/preview$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await ingest.preview(s, 'employee_master', await readJson(req)) }) },
  { method: 'POST', pattern: /^\/ingest\/employee-master\/commit$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await ingest.commit(s, 'employee_master', body, opts) };
    } },
  // Payroll master (Kira 2026-07-12): pay data behind the SAME high-authority
  // ingest gate + maker-checker; values land in employee_pay (pay-gated reads).
  { method: 'POST', pattern: /^\/ingest\/payroll-master\/preview$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await ingest.preview(s, 'payroll_master', await readJson(req)) }) },
  { method: 'POST', pattern: /^\/ingest\/payroll-master\/commit$/, allow: 'ingest.roles',
    handler: async (req, m, url, s) => {
      const body = await readJson(req);
      const opts = process.env.NODE_ENV !== 'production' && body.faultStep ? { faultStep: body.faultStep } : {};
      return { status: 200, body: await ingest.commit(s, 'payroll_master', body, opts) };
    } },
  { method: 'GET', pattern: /^\/ingest\/batch\/([0-9a-f-]+)\/exceptions$/i, allow: 'ingest.roles',
    handler: async (req, m, url, s) => ({ status: 200, body: await ingest.exceptionReport(s, m[1]) }) },
];

// Guard: verify session, then A2 module / RBAC action / registry deny-set if the
// route declares them. `deny` names a registry role-set config key (e.g. the
// directory access rule) — authoritative at the HTTP layer.
async function guard(route, req) {
  if (route.auth === false) return null;
  const session = await auth.verifySession(bearer(req));
  if (!session) throw new HttpError(401, 'authentication required');
  // KIOSK CONFINEMENT (Kira 2026-07-14, server-side by design): a kiosk
  // session reaches ONLY the routes flagged kioskOk (the punch). No leave, no
  // payslip, no profile, no directory — those live on the personal phone. A
  // kiosk session can never resolve to a full R13 surface.
  if (session.kind === 'kiosk' && !route.kioskOk) {
    throw new HttpError(403, 'kiosk session is clock-only');
  }
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
  // Wave 5 — CEO read-only: a strictly read-only role (auth.readonly.roles, the
  // R14 Executive by default) may not reach ANY mutating route. Structural, so a
  // future write route that forgets its own guard still cannot be hit by R14.
  // The ONE deliberate exception is a route flagged `readonlyOk` — R14's
  // config-pinned expatriate field-change decision (its maker-checker control).
  if (route.method !== 'GET' && !route.readonlyOk) {
    const readonly = await cfg.getRoleSet(session.company_id, 'auth.readonly.roles', 'R14');
    if (readonly.has(session.role_code)) throw new HttpError(403, 'forbidden');
  }
  return session;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function serveFile(dir, rel, res) {
  const full = path.normalize(path.join(dir, rel));
  if (!full.startsWith(dir)) return false;              // no path traversal
  const ext = path.extname(full);
  if (!MIME[ext]) return false;                         // whitelisted types only
  let buf;
  try { buf = fs.readFileSync(full); } catch { return false; }
  res.writeHead(200, { 'content-type': MIME[ext] });
  res.end(buf);
  return true;
}

// Static serving. With a designed build present: dist/ at the root with an
// SPA fallback to index.html (React Router owns page paths — API routes were
// already tried first), scaffold under /legacy. Without one: scaffold at the
// root, exactly as before.
function serveStatic(pathname, res) {
  const hasDist = fs.existsSync(path.join(DIST_DIR, 'index.html'));
  if (pathname.startsWith('/legacy')) {
    const rel = pathname.replace(/^\/legacy\/?/, '') || 'index.html';
    return serveFile(WEB_DIR, rel, res);
  }
  const root = hasDist ? DIST_DIR : WEB_DIR;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (serveFile(root, rel, res)) return true;
  // SPA fallback: only for extension-less page paths, only when dist serves.
  if (hasDist && !path.extname(rel)) return serveFile(DIST_DIR, 'index.html', res);
  return false;
}

// A browser NAVIGATION (Accept: text/html) to an extension-less page path gets
// the designed app shell even where the path shadows an API route (/controls,
// /alerts, …). This is a SERVING distinction, not a guard bypass: API clients
// never send text/html (fetch/curl/tests default Accept: */*), the shell then
// calls the API with its bearer token, and the route guards decide as always.
// /health and /legacy stay verbatim.
function wantsAppShell(req, pathname) {
  if (req.method !== 'GET') return false;
  if (!/\btext\/html\b/.test(req.headers.accept || '')) return false;
  if (path.extname(pathname)) return false;
  if (/^\/(health|legacy)(\/|$)/.test(pathname)) return false;
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (wantsAppShell(req, url.pathname) && serveFile(DIST_DIR, 'index.html', res)) return;
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
