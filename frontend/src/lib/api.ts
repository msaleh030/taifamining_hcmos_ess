// The single place the frontend talks to the backend — a 1:1 typed port of the
// certified vanilla scaffold's web/api.js (the FUNCTIONAL spec; behaviour is
// not re-derived). Session token in sessionStorage; every request carries the
// Bearer token; errors surface the backend's own status + body so screens
// render the backend's decision (403 → no-access, 422 → schema block, …),
// never a guess.
import type * as T from './types';

const TOKEN_KEY = 'hcmos.token';
const ROLE_KEY = 'hcmos.role';

export const session = {
  get token(): string | null { return sessionStorage.getItem(TOKEN_KEY); },
  get role(): string | null { return sessionStorage.getItem(ROLE_KEY); },
  set(v: { token?: string; role?: string }) {
    if (v.token) sessionStorage.setItem(TOKEN_KEY, v.token);
    if (v.role) sessionStorage.setItem(ROLE_KEY, v.role);
  },
  clear() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(ROLE_KEY); },
  get isAuthed(): boolean { return !!this.token; },
};

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}
export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

async function request<Out>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<Out> {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError((data && data.error) || `HTTP ${res.status}`, res.status, data);
  return data as Out;
}

export const api = {
  // Public login config (pre-auth): drives the MFA field's visibility. Same key
  // the server enforces, so the field and enforcement flip together.
  authConfig: () => request<{ mfaRequired: boolean }>('/auth/config'),
  async login(email: string, password: string, mfa: string): Promise<T.LoginOut> {
    const out = await request<T.LoginOut>('/auth/console', { method: 'POST', body: { email, password, mfa } });
    session.set({ token: out.token, role: out.role });
    return out;
  },
  logout() { session.clear(); },
  landing: () => request<T.Landing>('/me/landing'),
  reportsSummary: () => request<unknown>('/reports/summary'),

  // F1 — directory + profile (maker-checker).
  directory(params: Record<string, string | number | null | undefined> = {}) {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    return request<T.DirectoryPage>('/employees' + (qs ? `?${qs}` : ''));
  },
  employee: (id: string) => request<T.Employee>(`/employees/${id}`),
  documents: (id: string) => request<unknown>(`/employees/${id}/documents`),
  requestChange: (id: string, field: string, value: string) =>
    request<unknown>(`/employees/${id}/change`, { method: 'POST', body: { field, value } }),
  approveChange: (changeId: string) => request<unknown>(`/field-change/${changeId}/approve`, { method: 'POST' }),
  declineChange: (changeId: string) => request<unknown>(`/field-change/${changeId}/decline`, { method: 'POST' }),

  // F2 — disciplinary action + fan-out (one confirmed call).
  issueDiscipline: (id: string, body: { actionType: string; detail: string; approverUserId: string }) =>
    request<T.DisciplineOut>(`/employees/${id}/disciplinary`, { method: 'POST', body }),

  // F3 — leave (self-service) + liability (pay-adjacent, guarded).
  leaveBalance: () => request<T.LeaveBalance>('/leave/balance'),
  leaveApply: (body: { leave_type: string; days?: number; weeks?: number; hoh_override?: boolean }) =>
    request<unknown>('/leave/apply', { method: 'POST', body }),
  liabilityBatch: (batchId: string) => request<T.LiabilityOut>(`/liability/batch/${batchId}`),

  // F4 — KPI scorecard (role-scoped, feature-flagged) + My KPIs (self only).
  scorecard: () => request<T.KpiPayload>('/kpi/scorecard'),
  myKpis: () => request<T.KpiPayload>('/kpi/mine'),

  // F5 — attendance clock-in. The server re-validates; the client cannot assert in.
  clockIn: (loc: { lat: number; lng: number; accuracy: number; idempotency_key: string }) =>
    request<T.ClockInOut>('/attendance/clock-in', { method: 'POST', body: loc }),

  // F6 — Exact payroll integration (pay-guarded). Upload → reconcile → net-check
  // → control-totals → publish. The server BLOCKS on schema-fail and on totals
  // that don't reconcile; the client cannot click past either.
  exactUpload: (body: { period: string; csv: string; control_totals: Record<string, string | null> }) =>
    request<T.ExactUploadOut>('/exact/upload', { method: 'POST', body }),
  exactReconcile: (id: string) => request<T.ExactReconcileOut>(`/exact/batch/${id}/reconcile`, { method: 'POST' }),
  exactNetCheck: (id: string) => request<T.ExactNetCheckOut>(`/exact/batch/${id}/net-check`),
  exactControlTotals: (id: string) => request<T.ControlTotalsOut>(`/exact/batch/${id}/control-totals`),
  exactPublish: (id: string) => request<T.ExactPublishOut>(`/exact/batch/${id}/publish`, { method: 'POST' }),
  // Scoped retry of the publish fan-out — re-drives only the failed legs (the GL
  // leg is never re-posted once done).
  exactPublishRetry: (id: string) => request<T.ExactPublishOut>(`/exact/batch/${id}/publish/retry`, { method: 'POST' }),
  exactBatch: (id: string) => request<unknown>(`/exact/batch/${id}`),

  // F7 — alerts (compliance), support (self-service raise; agent lifecycle),
  // policy (self-service read/ack; admin publish).
  alertsRun: (asOf?: string) => request<T.AlertsRunOut>('/alerts/run', { method: 'POST', body: { asOf } }),
  alerts: () => request<T.AlertsOut>('/alerts'),
  supportRaise: (body: { subject: string; body: string; channel: string }) =>
    request<unknown>('/support/tickets', { method: 'POST', body }),
  supportList: () => request<T.SupportListOut>('/support/tickets'),
  supportTicket: (id: string) => request<unknown>(`/support/tickets/${id}`),
  supportTransition: (id: string, to: string) =>
    request<unknown>(`/support/tickets/${id}/transition`, { method: 'POST', body: { to } }),
  policyRead: (code: string) => request<T.Policy>(`/policy/${encodeURIComponent(code)}`),
  policyAck: (code: string) => request<T.PolicyAckOut>(`/policy/${encodeURIComponent(code)}/ack`, { method: 'POST' }),
  policyOutstanding: (code: string) => request<unknown>(`/policy/${encodeURIComponent(code)}/outstanding`),
  policyPublish: (body: unknown) => request<unknown>('/policy', { method: 'POST', body }),
  controls: () => request<T.ControlsOut>('/controls'),
  // F8 — tenant provisioning (platform-admin only; companyId minted server-side).
  provisionTenant: (name: string) => request<T.TenantOut>('/tenants', { method: 'POST', body: { name } }),
};

// A3: the API OMITS confidential fields a role may not see, so the UI simply
// does not render them (absent, never masked). This lists the confidential
// fields that COULD appear so a screen can iterate present ones without guessing.
export const CONFIDENTIAL_FIELDS = ['basic_pay', 'bank_account', 'osha_status', 'permit_no', 'disciplinary'] as const;

export type PresentedCard =
  | { kind: 'not-available'; label: string; reason: string }
  | { kind: 'value'; value: T.KpiCard['value']; rag: string | null; target: T.KpiCard['target'] };

// Shared render convention: a not-available card names its missing input; a
// value card carries its RAG status — never a guessed zero.
export function presentCard(card: T.KpiCard): PresentedCard {
  if (card && card.available === false) {
    return { kind: 'not-available', label: 'Not available', reason: card.missing || card.reason || 'input not captured' };
  }
  return { kind: 'value', value: card.value, rag: card.rag || card.status || null, target: card.target };
}
