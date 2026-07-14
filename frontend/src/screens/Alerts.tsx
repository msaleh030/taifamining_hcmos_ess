// C20b — Expiry alerts (DOC-01, DA-1/DA-2, UNI-06). The certified backend
// exposes the sweep (POST /alerts/run) and the open-alert list; each alert
// names the DA-2 role it was routed to. The spec ALSO draws per-doc-type
// lead-time CONFIGURATION (90/60/30/7 chips, set/repeat/clear) — those
// endpoints do not exist yet; the lead times shown ride the registry values
// and the config surface is flagged on the Kira list (view layer builds
// nothing the backend cannot honour).
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Skeleton, ErrorBanner, NoPermission, EmptyState, Tag } from '../components/state';
import { IcAlert, IcBell, IcCheck } from '../components/icons';

export default function Alerts() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const alerts = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, retry: false });
  const run = useMutation({
    mutationFn: (asOf?: string) => api.alertsRun(asOf),
    onSuccess: (r) => {
      setMessage({ ok: true, text: `${t('governance.successAlertTitle')} — ${r.raised.length} / ${r.cleared.length} / ${r.open_count}` });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (err) => setMessage({
      ok: false,
      text: isApiError(err) && err.status === 403 ? t('governance.noPermAlertsBody') : (err instanceof Error && err.message) || t('governance.errBody'),
    }),
  });

  if (alerts.isError) {
    return isApiError(alerts.error) && alerts.error.status === 403
      ? <NoPermission title={t('governance.noPermAlertsTitle')} body={t('governance.noPermAlertsBody')} why={t('governance.noPermAlertsWhy')} />
      : <ErrorBanner text={t('governance.errBody')} onRetry={() => alerts.refetch()} retryLabel={t('governance.retry')} />;
  }

  return (
    <div className="grid" data-state={alerts.isPending ? 'loading' : 'populated'}>
      <div className="card card-p">
        <div className="shead">{t('governance.leadTitle')}</div>
        <p className="muted" style={{ margin: '4px 0 10px', fontSize: 12.5 }}>{t('governance.leadSub')}</p>
        <div className="sitefilter">
          {[90, 60, 30, 7].map((d) => <span key={d} className="pill on num">{d}d</span>)}
          <span className="note" style={{ padding: '6px 0' }}>{t('governance.alertNote')}</span>
        </div>
        <form style={{ marginTop: 12, display: 'flex', gap: 8 }} onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          run.mutate(String(new FormData(e.currentTarget).get('asof') ?? '').trim() || undefined);
        }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <input name="asof" placeholder="as-of YYYY-MM-DD" />
          </div>
          <button className="btn primary" type="submit" disabled={run.isPending}>{t('governance.runNow')}</button>
        </form>
        {message && (
          <div className={`banner ${message.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }} role={message.ok ? undefined : 'alert'}>
            {message.ok ? <IcCheck /> : <IcAlert />}{message.text}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-h"><h3>{t('governance.alerts')}</h3>
          <span className="meta num">{alerts.data?.open.length ?? ''}</span></div>
        {alerts.isPending ? <div className="card-p"><Skeleton rows={4} /></div> : alerts.data.open.length === 0 ? (
          <EmptyState title={t('governance.emptyAlertsTitle')} body={t('governance.emptyAlertsBody')} icon={<IcBell />} />
        ) : (
          <table className="tbl">
            <thead><tr><th>{t('governance.alertDoc')}</th><th>{t('governance.dueIn')}</th><th>{t('governance.notifyTitle')}</th></tr></thead>
            <tbody>
              {alerts.data.open.map((a, i) => (
                <tr key={i}>
                  <td className="name">{a.kind}</td>
                  <td className="num">{a.due_date}</td>
                  <td><Tag tone="yellow">{a.notify_role || t('exact.na')}</Tag>{(a.notify_count ?? 1) > 1 ? <span className="muted num"> ×{a.notify_count}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
