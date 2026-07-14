// API response shapes, transcribed from the certified backend's actual
// responses (the vanilla scaffold is the functional spec — behaviour is not
// re-derived here). Confidential fields are OPTIONAL because the server OMITS
// what a role may not see (A3): absent, never masked, never null-as-hidden.

export interface LoginOut { token: string; role: string }

export interface Landing {
  role: string;
  name: string;
  modules: string[];
}

export interface DirectoryRow {
  id: string;
  emp_no?: string;
  full_name: string;
  dept?: string;
  status: string;
}
export interface DirectoryPage { rows: DirectoryRow[]; next_cursor: string | null }

export interface PendingChange { id: string; field: string; before: string; after: string }
// Profile: an open map — the screen renders ONLY the keys present.
export type Employee = Record<string, unknown> & { pending_changes?: PendingChange[] };

// A value card or a not-available card naming its missing input (never a zero).
export interface KpiCard {
  name: string;
  available?: boolean;
  missing?: string;
  reason?: string;
  value?: number | string;
  rag?: string;
  status?: string;
  target?: number | string;
}
export interface KpiPayload { enabled: boolean; cards?: KpiCard[] }

export interface SickBucket { taken: number; available: number | { available: false; missing: string } }
export interface LeaveBalance {
  annual: { available: number; entitlement: number; carried: number; taken: number };
  sick: SickBucket;
}

export interface LiabilityOut {
  total: string | number;
  available: { employee_id: string; days: number; daily_rate: string; liability: string }[];
  not_available?: { employee_id: string; missing: string }[];
  excluded?: { employee_id: string; status: string }[];
}

export interface ClockInOut { retry?: boolean; reason?: string; zone?: string }
// ESS-5 — clock-out, shift status, sync-conflict resolution.
export interface ClockOutOut { retry?: boolean; reason?: string; zone?: string; since?: string }
export interface AttLast { id: string; direction: 'in' | 'out'; at: string; via: string; zone?: string | null; review_flag?: string | null }
export interface AttStatusOut { open: boolean; since: string | null; last: AttLast | null }
export interface ConflictServer { attendance_id: string; punched_at: string; via: string; zone?: string | null }
export interface ResolveOut { resolved?: boolean; retry?: boolean; reason?: string; resolution?: string; attendance_id?: string; flagged?: string }

export interface ExactUploadOut { batch_id: string; row_count: number; deduped?: boolean }
export interface ExactReconcileOut { matched: number; key: string; unmatched: { employee_id: string }[] }
export interface ExactNetCheckOut { checked: number; mismatches: { row_no: number }[] }
export interface ControlTotalsOut {
  ok: boolean;
  computed: { net: string };
  mismatches: { field: string; declared: string; computed: string }[];
}
export type LegStatus = { status: string; error?: string };
export interface ExactPublishOut { legs: Record<string, LegStatus> }

export interface AlertRow { kind: string; due_date: string; notify_role?: string; notify_count?: number }
export interface AlertsOut { open: AlertRow[] }
export interface AlertsRunOut { raised: unknown[]; cleared: unknown[]; open_count: number }

export interface Ticket { id: string; subject: string; status: 'open' | 'in_progress' | 'resolved' | 'closed' }
export interface SupportListOut { scope: string; tickets: Ticket[] }

export interface Policy { title: string; version: string | number; body?: string }
export interface PolicyAckOut { version: string | number }

export interface ControlCheck { check: string; pass: boolean; checked: number; offenders: unknown[] }
export interface ControlsOut { all_pass: boolean; checks: ControlCheck[] }

export interface TenantOut { company_id: string; name: string; config_keys: number; sites: number }

export interface DisciplineOut { action_type: string; manager?: string; suspended?: boolean }

// E6 — ESS payslip (PRT-02). Wording is law: total_pay / net_pay, never
// "Total Allowance". Shapes mirror src/payslip.js verbatim.
export interface PayslipPeriod { batch_id: string; period: string | null; published_at: string; net_pay: number }
export interface PayslipItem { label: string; amount: number }
export interface PayslipOut {
  payslip: null | {
    batch_id: string; period: string | null; published_at: string;
    employee: { emp_no: string | null; full_name: string };
    earnings: PayslipItem[];
    deductions: PayslipItem[];
    totals: { total_pay: number; total_deduction: number; net_pay: number };
  };
}
