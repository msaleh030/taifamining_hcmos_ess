'use strict';
// Slice 7 — KPI compute (KPI-01..04).
//
// Each KPI is a card: value, formula, target, progress, RAG status. KPIs compute
// LIVE from real data where the input exists; where an input is not yet captured
// (survey scores, recruitment cost/time, training hours, demographic/succession),
// the card is NOT-AVAILABLE naming the missing input (the LIAB-03 pattern) — never
// a zero or a guessed percentage.
//
//  - Role-scope (A2/A3): the org scorecard shows only the KPIs a role owns.
//  - My KPIs (E8): every employee sees their own personal cards (self only).
//  - LVR-02: populations count ACTIVE staff only (leavers excluded).
//  - Feature flag: analytics.enabled is a TENANT-WIDE module flag governing BOTH
//    the org scorecard (C3) AND personal My KPIs (E8) — when off, both return
//    { enabled:false, cards:[] } regardless of role (the flag overrides role).
//    The compute engine (computeOne) still exists for internal/drill-down use.
const db = require('./db');
const cfg = require('./config');
const { HttpError } = require('./errors');

const round2 = (x) => Math.round(x * 100) / 100;

// Owner groups (A2/A3). Role codes that "own" a KPI on the org scorecard.
const HR   = ['R03', 'R04', 'R11', 'R12'];
const EXEC = ['R11', 'R12'];
const HSE  = ['R05', 'R06'];
const PAY  = ['R11', 'R12', 'R15', 'R16']; // v1.5: R09 → Finance Manager/CFC
const SUP  = ['R02', 'R04', 'R11'];

// count of ACTIVE employees (LVR-02) — leavers excluded.
const activeHeadcount = async (c) =>
  (await c.query("SELECT count(*)::int n FROM employee WHERE status='active'")).rows[0].n;

// KPI definitions. `compute(ctx)` returns a number (live) OR a def carries
// `input` (not captured yet → not-available). Directions:
//   up   → progress = value/target; green/amber are progress-ratio thresholds
//   down → green/amber are absolute value ceilings (lower is better)
const DEFS = [
  // ── Workforce & movement ──
  { id: 'WF-01', name: 'Active Headcount', category: 'Workforce', owners: HR,
    formula: "count(employee where status='active')", target: 5000, direction: 'up', green: 0.95, amber: 0.85,
    compute: ({ client }) => activeHeadcount(client) },
  { id: 'WF-02', name: 'Turnover Rate %', category: 'Workforce', owners: HR,
    formula: 'leavers / avg headcount', target: 8, direction: 'down', green: 8, amber: 12,
    input: 'leaver dates for the period' },
  { id: 'WF-03', name: 'New Hires (period)', category: 'Workforce', owners: HR,
    formula: 'count(hires in period)', target: 50, direction: 'up', green: 0.9, amber: 0.7,
    input: 'reporting period boundaries' },
  { id: 'WF-04', name: 'Vacancy Fill Time (days)', category: 'Workforce', owners: HR,
    formula: 'avg(close - open)', target: 30, direction: 'down', green: 30, amber: 45,
    input: 'requisition open/close dates' },

  // ── Diversity (splits into 4) ──
  { id: 'DIV-01', name: 'Gender Split %', category: 'Diversity', owners: HR,
    formula: 'women / active', target: 30, direction: 'up', green: 0.9, amber: 0.7, input: 'gender / demographic data' },
  { id: 'DIV-02', name: 'Age Distribution', category: 'Diversity', owners: HR,
    formula: 'bands(active)', target: null, direction: 'up', green: 0.9, amber: 0.7, input: 'date-of-birth / demographic data' },
  { id: 'DIV-03', name: 'Local Content %', category: 'Diversity', owners: HR,
    formula: 'nationals / active', target: 90, direction: 'up', green: 0.95, amber: 0.85, input: 'nationality / demographic data' },
  { id: 'DIV-04', name: 'Disability Inclusion %', category: 'Diversity', owners: HR,
    formula: 'pwd / active', target: 3, direction: 'up', green: 0.9, amber: 0.7, input: 'disability / demographic data' },

  // ── Recruitment ──
  { id: 'REC-01', name: 'Cost per Hire', category: 'Recruitment', owners: HR,
    formula: 'total cost / hires', target: 2000, direction: 'down', green: 2000, amber: 3000, input: 'recruitment cost' },
  { id: 'REC-02', name: 'Time to Hire (days)', category: 'Recruitment', owners: HR,
    formula: 'avg(offer - applied)', target: 45, direction: 'down', green: 45, amber: 60, input: 'recruitment timeline' },

  // ── Training ──
  { id: 'TRN-01', name: 'Training Hours / Employee', category: 'Training', owners: HR,
    formula: 'hours / active', target: 40, direction: 'up', green: 0.9, amber: 0.7, input: 'training hours' },
  { id: 'TRN-02', name: 'Training Completion %', category: 'Training', owners: HR,
    formula: 'completed / assigned', target: 90, direction: 'up', green: 0.95, amber: 0.85, input: 'training records' },

  // ── Engagement ──
  { id: 'ENG-01', name: 'Engagement Score %', category: 'Engagement', owners: EXEC,
    formula: 'survey mean', target: 75, direction: 'up', green: 0.95, amber: 0.85, input: 'survey scores' },
  { id: 'ENG-02', name: 'eNPS', category: 'Engagement', owners: EXEC,
    formula: 'promoters - detractors', target: 20, direction: 'up', green: 0.9, amber: 0.7, input: 'survey scores' },

  // ── Leave ──
  { id: 'LV-01', name: 'Outstanding Leave Days (active)', category: 'Leave', owners: HR,
    formula: 'sum(open carry days) for active staff', target: 5000, direction: 'down', green: 5000, amber: 10000,
    compute: async ({ client }) => round2(Number((await client.query(
      `SELECT coalesce(sum(lc.days),0)::float8 d FROM leave_carry lc JOIN employee e ON e.id=lc.employee_id
        WHERE lc.lapsed_at IS NULL AND e.status='active'`)).rows[0].d)) },
  { id: 'LV-02', name: 'Leave Liability Value', category: 'Leave', owners: HR,
    formula: 'Σ days × (remuneration / 30)', target: 0, direction: 'down', green: 0, amber: 0, input: 'monthly remuneration (Exact)' },

  // ── Discipline & safety ──
  { id: 'DISC-01', name: 'Disciplinary Actions', category: 'Discipline', owners: [...HR, ...HSE],
    formula: 'count(disciplinary)', target: 0, direction: 'down', green: 5, amber: 15,
    compute: async ({ client }) => (await client.query('SELECT count(*)::int n FROM disciplinary')).rows[0].n },
  { id: 'SAF-01', name: 'LTIFR', category: 'Safety', owners: HSE,
    formula: 'lost-time injuries × 1e6 / hours', target: 1, direction: 'down', green: 1, amber: 3, input: 'safety incident data' },
  { id: 'SAF-02', name: 'Medical Clearance Valid %', category: 'Safety', owners: HSE,
    formula: 'cleared / active', target: 95, direction: 'up', green: 0.95, amber: 0.85, input: 'medical clearance capture' },

  // ── Payroll / cost ──
  { id: 'PAY-01', name: 'Payroll Cost (period)', category: 'Payroll', owners: PAY,
    formula: 'Σ net pay (published period)', target: null, direction: 'down', green: 0, amber: 0, input: 'published Exact period' },
  { id: 'PAY-02', name: 'Overtime %', category: 'Payroll', owners: PAY,
    formula: 'overtime / basic', target: 5, direction: 'down', green: 5, amber: 10, input: 'overtime capture' },

  // ── Performance & succession ──
  { id: 'PERF-01', name: 'Performance Reviews Completed %', category: 'Performance', owners: [...HR, ...EXEC],
    formula: 'completed / due', target: 90, direction: 'up', green: 0.95, amber: 0.85, input: 'appraisal records' },
  { id: 'SUC-01', name: 'Succession Coverage %', category: 'Succession', owners: EXEC,
    formula: 'covered critical roles / critical roles', target: 80, direction: 'up', green: 0.95, amber: 0.85, input: 'succession plans' },

  // ── Attendance ──
  { id: 'ATT-01', name: 'Attendance Compliance %', category: 'Attendance', owners: SUP,
    formula: 'valid clock-ins / expected', target: 95, direction: 'up', green: 0.95, amber: 0.85, input: 'clock-in records' },

  // ── Personal — My KPIs (E8), self only ──
  { id: 'MY-01', name: 'My Outstanding Leave Days', category: 'My KPIs', owners: [], personal: true,
    formula: 'sum(open carry days) for me', target: 0, direction: 'down', green: 999, amber: 999,
    compute: async ({ client, employeeId }) => round2(Number((await client.query(
      `SELECT coalesce(sum(days),0)::float8 d FROM leave_carry WHERE employee_id=$1 AND lapsed_at IS NULL`,
      [employeeId])).rows[0].d)) },
  { id: 'MY-02', name: 'My Disciplinary Record', category: 'My KPIs', owners: [], personal: true,
    formula: 'count(disciplinary for me)', target: 0, direction: 'down', green: 0, amber: 1,
    compute: async ({ client, employeeId }) =>
      (await client.query('SELECT count(*)::int n FROM disciplinary WHERE employee_id=$1', [employeeId])).rows[0].n },
  { id: 'MY-03', name: 'My Training Hours', category: 'My KPIs', owners: [], personal: true,
    formula: 'sum(my training hours)', target: 40, direction: 'up', green: 0.9, amber: 0.7, input: 'training hours' },
];

// RAG + progress from a computed value.
function ragFor(def, value) {
  if (def.direction === 'down') {
    const rag = value <= def.green ? 'green' : value <= def.amber ? 'amber' : 'red';
    const progress = def.target ? round2(Math.min(1, value === 0 ? 1 : def.target / value)) : null;
    return { rag, progress };
  }
  const progress = def.target ? round2(value / def.target) : null;
  const rag = progress === null ? 'grey' : progress >= def.green ? 'green' : progress >= def.amber ? 'amber' : 'red';
  return { rag, progress };
}

async function computeCard(def, ctx) {
  const base = {
    id: def.id, name: def.name, category: def.category, formula: def.formula,
    target: def.target, owners: def.owners, personal: !!def.personal,
  };
  if (def.input) return { ...base, available: false, status: 'not-available', missing: def.input };
  const value = await def.compute(ctx);
  if (value == null) return { ...base, available: false, status: 'not-available', missing: 'data' };
  const { rag, progress } = ragFor(def, value);
  return { ...base, available: true, value, progress, rag, status: rag };
}

async function analyticsEnabled(companyId) {
  return (await cfg.getConfig(companyId, 'analytics.enabled', 'false')) === 'true';
}

// Org scorecard: only the KPIs the role owns (A2/A3); gated by the analytics flag.
async function scorecard(session) {
  const enabled = await analyticsEnabled(session.company_id);
  const owned = DEFS.filter((d) => !d.personal && d.owners.includes(session.role_code));
  if (!enabled) return { enabled: false, cards: [] };
  return db.withTenant(session.company_id, async (client) => {
    const ctx = { client, companyId: session.company_id, session };
    const cards = [];
    for (const d of owned) cards.push(await computeCard(d, ctx));
    return { enabled: true, cards };
  });
}

// My KPIs (E8): personal cards for the requester only (self). Gated by the SAME
// tenant-wide analytics flag as the scorecard — off → { enabled:false, cards:[] }
// for every role (the flag overrides role), so the screen shows the disabled panel.
async function myKpis(session) {
  const enabled = await analyticsEnabled(session.company_id);
  if (!enabled) return { enabled: false, cards: [] };
  return db.withTenant(session.company_id, async (client) => {
    const emp = (await client.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id])).rows[0];
    const employeeId = emp && emp.employee_id;
    const ctx = { client, employeeId, session };
    const cards = [];
    for (const d of DEFS.filter((x) => x.personal)) cards.push(await computeCard(d, ctx));
    return { enabled: true, employee_id: employeeId, cards };
  });
}

// Compute a single KPI by id (used by tests / drill-downs).
async function computeOne(session, id) {
  const def = DEFS.find((d) => d.id === id);
  if (!def) throw new HttpError(404, 'unknown kpi');
  return db.withTenant(session.company_id, async (client) => {
    const ctx = { client, companyId: session.company_id, session };
    if (def.personal) {
      const emp = (await client.query('SELECT employee_id FROM app_user WHERE id=$1', [session.user_id])).rows[0];
      ctx.employeeId = emp && emp.employee_id;
    }
    return computeCard(def, ctx);
  });
}

module.exports = { DEFS, ragFor, scorecard, myKpis, computeOne, analyticsEnabled };
