// E12 — Support tickets. Raising is self-service; the list is RECORD-SCOPED
// BY THE SERVER (a raiser sees only their own tickets, a support agent sees
// all — the scope chip reports which). Lifecycle transitions are an agent
// action; a non-agent attempt is a 403 surfaced verbatim.
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { Ticket } from '../lib/types';
import { Skeleton, ErrorBanner, EmptyState, Tag } from '../components/state';
import { IcAlert, IcCheck, IcLifeBuoy } from '../components/icons';

const NEXT: Record<Ticket['status'], string[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};
const TONE: Record<string, 'blue' | 'yellow' | 'green' | 'grey'> = {
  open: 'blue', in_progress: 'yellow', resolved: 'green', closed: 'grey',
};

export default function Support() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['support'] });

  const list = useQuery({ queryKey: ['support'], queryFn: api.supportList, retry: false });

  const raise = useMutation({
    mutationFn: (body: { subject: string; body: string; channel: string }) => api.supportRaise(body),
    onSuccess: () => { setMessage({ ok: true, text: t('governance.successSupportTitle') }); refresh(); },
    onError: (err) => setMessage({ ok: false, text: (err instanceof Error && err.message) || t('governance.errBody') }),
  });
  const transition = useMutation({
    mutationFn: (v: { id: string; to: string }) => api.supportTransition(v.id, v.to),
    onSuccess: refresh,
    onError: (err) => setMessage({
      ok: false,
      text: isApiError(err) && err.status === 403 ? t('governance.supportOwnNote') : (err instanceof Error && err.message) || t('governance.errBody'),
    }),
  });

  return (
    <div className="grid" style={{ maxWidth: 820 }}>
      <form className="card card-p" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        raise.mutate({
          subject: String(f.get('subject') ?? '').trim(),
          body: String(f.get('body') ?? '').trim(),
          channel: String(f.get('channel')),
        });
        e.currentTarget.reset();
      }}>
        <div className="shead">{t('governance.raiseCta')}</div>
        <div className="fg" style={{ marginTop: 10 }}>
          <div className="field"><label>{t('governance.tkSubject')} <span className="req">*</span></label>
            <input name="subject" required /></div>
          <div className="field"><label>{t('governance.tkChannel')}</label>
            <select name="channel"><option value="in_app">in-app</option><option value="email">email</option></select></div>
          <div className="field full"><label>{t('governance.tkDetail')}</label>
            <textarea name="body" /></div>
        </div>
        <button className="btn primary" style={{ marginTop: 10 }} type="submit" disabled={raise.isPending}>
          {t('governance.raiseCta')}
        </button>
        {message && (
          <div className={`banner ${message.ok ? 'ok' : 'err'}`} style={{ marginTop: 10 }} role={message.ok ? undefined : 'alert'}>
            {message.ok ? <IcCheck /> : <IcAlert />}{message.text}
          </div>
        )}
      </form>

      <div className="card">
        <div className="card-h">
          <h3>{t('governance.ticketList')}</h3>
          {list.data && <span className="scope meta">{list.data.scope}</span>}
        </div>
        {list.isPending ? <div className="card-p"><Skeleton rows={4} /></div> : list.isError ? (
          <div className="card-p"><ErrorBanner text={t('governance.errBody')} onRetry={() => list.refetch()} retryLabel={t('governance.retry')} /></div>
        ) : list.data.tickets.length === 0 ? (
          <EmptyState title={t('governance.emptySupportTitle')} body={t('governance.emptySupportBody')} icon={<IcLifeBuoy />} />
        ) : (
          <table className="tbl">
            <thead><tr><th>#</th><th>{t('governance.tkSubject')}</th><th>{t('governance.tkPriority')}</th><th /></tr></thead>
            <tbody>
              {list.data.tickets.map((tk) => (
                <tr key={tk.id}>
                  <td className="num muted">{tk.id.slice(0, 8)}</td>
                  <td className="name">{tk.subject}</td>
                  <td><Tag tone={TONE[tk.status] ?? 'grey'}>{tk.status.replace('_', ' ')}</Tag></td>
                  <td style={{ textAlign: 'right' }}>
                    {(NEXT[tk.status] ?? []).map((to) => (
                      <button key={to} className="btn sm ghost" onClick={() => transition.mutate({ id: tk.id, to })} disabled={transition.isPending}>
                        {to.replace('_', ' ')}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
