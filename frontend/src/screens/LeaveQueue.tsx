// P2 / C10 — the leave approval queue (LV-03), console track. THE RULES LIVE
// SERVER-SIDE and this screen only renders their verdicts:
//   • SOD-01: the approver is never the applicant — deciding your own request
//     comes back 403 and renders the designed self-approval refusal;
//   • LR-6 COVERAGE IS WARN-NOT-BLOCK: approving into a coverage gap returns
//     409 with the meter; the approver must ACKNOWLEDGE the gap (checkbox) and
//     resubmit — the override is recorded on the audit chain (UNI-06) by the
//     server, never silently;
//   • a site-bound approver sees only their scope; the queue answer IS the
//     scope (no client filtering).
// Each pending card: person, number, site, type/days/window, applied-at, and
// the coverage meter (ok / warn / pending-with-reason — LR-6 unconfigured or
// windowless requests read "pending", approval proceeds without override).
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { LeaveCoverage, LeaveQueueItem } from '../lib/types';
import { Skeleton, EmptyState, ErrorBanner, NoPermission, Seal, Tag } from '../components/state';
import { IcAlert, IcCalendar, IcCheck, IcShield, IcX } from '../components/icons';

function CoverageChip({ c }: { c: LeaveCoverage }) {
  const { t } = useTranslation();
  if (c.status === 'ok') {
    return <Tag tone="green">{t('leave.coverage')} · {c.present}/{c.threshold} {t('leave.covPresent')}</Tag>;
  }
  if (c.status === 'warn') {
    return <Tag tone="yellow">{t('leave.covWarnTitle')} · {c.present}/{c.threshold} {t('leave.covPresent')}</Tag>;
  }
  return <Tag tone="grey">{t('leave.coverage')} · {c.reason}</Tag>;
}

function QueueCard({ item }: { item: LeaveQueueItem }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [gap, setGap] = useState<LeaveCoverage | null>(null); // the 409 meter
  const [ack, setAck] = useState(false);
  const [selfRefused, setSelfRefused] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState<'approved' | 'declined' | null>(null);
  const [overridden, setOverridden] = useState(false);

  const decide = useMutation({
    mutationFn: (v: { approve: boolean; override_ack?: boolean }) => api.leaveDecide(item.id, v),
    onSuccess: (res) => {
      setGap(null); setFailed(false);
      setDone(res.status); setOverridden(res.coverage_override);
      queryClient.invalidateQueries({ queryKey: ['leave-queue'] });
    },
    onError: (err: Error) => {
      if (isApiError(err) && err.status === 409 && (err.body as { coverage?: LeaveCoverage })?.coverage) {
        setGap((err.body as { coverage: LeaveCoverage }).coverage); // LR-6 warn — ask for the acknowledged override
      } else if (isApiError(err) && err.status === 403) {
        setSelfRefused(true); // SOD-01 (or out-of-scope) — the server refused the decision
      } else {
        setFailed(true);
      }
    },
  });

  if (done) {
    return (
      <div className="card card-p" data-state="success">
        <Seal title={done === 'approved' ? t('leave.successApproveTitle') : t('leave.rejectBtn')}
          sub={done === 'approved' ? t('leave.successApproveSub') : undefined} />
        {overridden && (
          <p className="note" style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
            <IcShield style={{ width: 13, height: 13 }} />{t('leave.overrideAudited')}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card card-p" data-state={gap ? 'error' : 'populated'}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span className="qt"><b>{item.full_name}</b></span>
        <span className="qd num">{item.emp_no ?? '—'}</span>
        <span className="qd">{item.site ?? '—'} · {item.role_code}</span>
        <span style={{ marginLeft: 'auto' }}><CoverageChip c={item.coverage} /></span>
      </div>
      <div className="qd" style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
        <IcCalendar style={{ width: 13, height: 13 }} />
        {item.leave_type} · <span className="num">{item.days}</span> {t('leave.dayU')}
        {item.from_date && <> · <span className="num">{item.from_date} → {item.to_date}</span></>}
        <span style={{ marginLeft: 'auto' }} className="num">{item.applied_at}</span>
        {item.hoh_override && <Tag tone="blue">{t('leave.hoh')}</Tag>}
      </div>

      {selfRefused && (
        <div className="banner err" style={{ marginTop: 10 }} role="alert">
          <IcAlert /><div><b>{t('leave.selfTitle')}</b> {t('leave.selfBody')}</div>
        </div>
      )}
      {failed && (
        <div className="banner err" style={{ marginTop: 10 }} role="alert">
          <IcAlert /><div><b>{t('leave.errApproveTitle')}</b> {t('leave.errApproveBody')}</div>
        </div>
      )}

      {/* LR-6 warn-not-block: the gap, the acknowledgment, the audited override */}
      {gap && (
        <div className="hoh" style={{ marginTop: 10 }}>
          <IcAlert style={{ width: 14, height: 14 }} />
          <span>
            <b>{t('leave.covWarnTitle')}</b> {gap.role} · {gap.present}/{gap.threshold} {t('leave.covPresent')}
            <br />{t('leave.ackBody')}
            <label style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 7, fontWeight: 600 }}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('leave.ackChk')}
            </label>
          </span>
        </div>
      )}

      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        {gap ? (
          <button className="btn w" disabled={!ack || decide.isPending}
            onClick={() => decide.mutate({ approve: true, override_ack: true })}>
            <IcCheck style={{ width: 14, height: 14 }} /> {t('leave.approveOverride')}
          </button>
        ) : (
          <button className="btn primary" disabled={decide.isPending || selfRefused}
            onClick={() => decide.mutate({ approve: true })}>
            <IcCheck style={{ width: 14, height: 14 }} /> {t('leave.approveBtn')}
          </button>
        )}
        <button className="btn" disabled={decide.isPending || selfRefused}
          onClick={() => decide.mutate({ approve: false })}>
          <IcX style={{ width: 14, height: 14 }} /> {t('leave.rejectBtn')}
        </button>
      </div>
      <p className="note" style={{ marginTop: 8 }}>{t('leave.matrixNote')}</p>
    </div>
  );
}

export default function LeaveQueue() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['leave-queue'], queryFn: api.leaveQueue, retry: false });

  if (q.isPending) return <div className="card card-p"><Skeleton rows={5} /></div>;
  if (q.isError) {
    if (isApiError(q.error) && q.error.status === 403) {
      return <NoPermission title={t('leave.selfTitle')} body={t('leave.matrixNote')} why="C10 · leave.approve (R02/R04/R11)" />;
    }
    return <ErrorBanner text={t('leave.errApproveBody')} onRetry={() => q.refetch()} retryLabel={t('leave.retry')} />;
  }

  const pending = q.data.pending;
  if (pending.length === 0) {
    return <EmptyState title={t('leave.emptyApproveTitle')} body={t('leave.emptyApproveBody')} icon={<IcCalendar />} />;
  }

  return (
    <div className="grid" style={{ maxWidth: 760 }} data-state="populated">
      <div className="shead">{t('leave.pendingTitle')} · <span className="num">{pending.length}</span></div>
      {pending.map((item) => <QueueCard key={item.id} item={item} />)}
    </div>
  );
}
