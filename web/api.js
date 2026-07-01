// F0 — API client. The single place the frontend talks to the backend. Replaces
// the prototype's localStorage: the session token lives in sessionStorage, and
// every request carries the Bearer token + tenant context. Generic errors are
// surfaced through the backend's own not-available / RAG conventions so screens
// render "Not available (input)" rather than a misleading zero.
const TOKEN_KEY = 'hcmos.token';
const ROLE_KEY = 'hcmos.role';

export const session = {
  get token() { return sessionStorage.getItem(TOKEN_KEY); },
  get role() { return sessionStorage.getItem(ROLE_KEY); },
  set({ token, role }) {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    if (role) sessionStorage.setItem(ROLE_KEY, role);
  },
  clear() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ROLE_KEY); },
  get isAuthed() { return !!this.token; },
};

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  async login(email, password, mfa) {
    const out = await request('/auth/console', { method: 'POST', body: { email, password, mfa } });
    session.set({ token: out.token, role: out.role });
    return out;
  },
  logout() { session.clear(); },
  landing: () => request('/me/landing'),
  reportsSummary: () => request('/reports/summary'),

  // F1 — directory + profile (maker-checker).
  directory: (params = {}) => {
    const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ''));
    const qs = q.toString();
    return request('/employees' + (qs ? `?${qs}` : ''));
  },
  employee: (id) => request(`/employees/${id}`),
  documents: (id) => request(`/employees/${id}/documents`),
  requestChange: (id, field, value) => request(`/employees/${id}/change`, { method: 'POST', body: { field, value } }),
  approveChange: (changeId) => request(`/field-change/${changeId}/approve`, { method: 'POST' }),
  declineChange: (changeId) => request(`/field-change/${changeId}/decline`, { method: 'POST' }),

  // F2 — disciplinary action + fan-out (one confirmed call).
  issueDiscipline: (id, body) => request(`/employees/${id}/disciplinary`, { method: 'POST', body }),

  // F3 — leave (self-service) + liability (pay-adjacent, guarded).
  leaveBalance: () => request('/leave/balance'),
  leaveApply: (body) => request('/leave/apply', { method: 'POST', body }),
  liabilityBatch: (batchId) => request(`/liability/batch/${batchId}`),

  // F4 — KPI scorecard (role-scoped, feature-flagged) + My KPIs (self only).
  scorecard: () => request('/kpi/scorecard'),
  myKpis: () => request('/kpi/mine'),

  // F5 — attendance clock-in. The server re-validates; the client cannot assert in.
  clockIn: (loc) => request('/attendance/clock-in', { method: 'POST', body: loc }),
};

// A3: the API OMITS confidential fields a role may not see, so the UI simply does
// not render them (absent, never masked). This lists the confidential fields that
// COULD appear so a screen can iterate present ones without guessing.
export const CONFIDENTIAL_FIELDS = ['basic_pay', 'bank_account', 'osha_status', 'permit_no', 'disciplinary'];

// Shared render convention: a not-available card names its missing input; a value
// card carries its RAG status. Screens use this so "wired" == same conventions
// as the backend (never a guessed zero).
export function presentCard(card) {
  if (card && card.available === false) {
    return { kind: 'not-available', label: 'Not available', reason: card.missing || card.reason || 'input not captured' };
  }
  return { kind: 'value', value: card.value, rag: card.rag || card.status || null, target: card.target };
}
