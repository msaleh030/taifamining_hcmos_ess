// F7 — document-expiry alerts (port of alerts.js, DA-1/DA-2). The endpoint is
// guarded to the document-compliance owners; a role without access gets the
// explained no-access state, never a blank screen. Each alert names the DA-2
// role it was routed to.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, Input, Msg, NoAccess, ErrorPanel, Loading, Panel } from '../components/ui';

export default function Alerts() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'blocked'; text: string } | null>(null);

  const alerts = useQuery({ queryKey: ['alerts'], queryFn: api.alerts, retry: false });
  const run = useMutation({
    mutationFn: (asOf?: string) => api.alertsRun(asOf),
    onSuccess: (r) => {
      setMessage({ kind: 'ok', text: t('alerts.swept', { raised: r.raised.length, cleared: r.cleared.length, open: r.open_count }) });
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (err) => setMessage({
      kind: 'blocked',
      text: isApiError(err) && err.status === 403 ? t('alerts.noRunAccess') : (err instanceof Error && err.message) || t('alerts.sweepFailed'),
    }),
  });

  if (alerts.isError) {
    return isApiError(alerts.error) && alerts.error.status === 403
      ? <NoAccess title={t('alerts.title')} message={t('alerts.noAccess')} />
      : <ErrorPanel message={t('alerts.error')} />;
  }

  return (
    <Panel title={t('alerts.title')} state={alerts.isPending ? 'loading' : 'ready'}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run.mutate(String(new FormData(e.currentTarget).get('asof') ?? '').trim() || undefined);
        }}
      >
        <Input name="asof" placeholder={t('alerts.asOf')} />
        <Button type="submit" disabled={run.isPending}>{t('alerts.run')}</Button>
      </form>
      <Msg kind={message?.kind}>{message?.text}</Msg>
      {alerts.isPending ? <Loading /> : alerts.data.open.length === 0 ? (
        <p data-state="empty" className="text-ink-muted">{t('alerts.none')}</p>
      ) : (
        <ul className="list-disc pl-5">
          {alerts.data.open.map((a, i) => (
            <li key={i}>
              {a.kind} — {t('alerts.due')} {a.due_date} → <strong>{a.notify_role || 'unassigned'}</strong> (×{a.notify_count ?? 1})
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
