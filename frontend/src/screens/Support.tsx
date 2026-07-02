// F7 — support tickets (port of support.js). Raising is self-service; the
// list is record-scoped by the SERVER (a raiser sees only their own, a support
// agent sees all — the scope line reports which). Lifecycle transitions are a
// support-agent action; a non-agent's attempt is a 403 surfaced verbatim.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { Ticket } from '../lib/types';
import { Button, GhostButton, Input, Msg, Select, ErrorPanel, Loading, Panel } from '../components/ui';

const NEXT: Record<Ticket['status'], string[]> = {
  open: ['in_progress', 'closed'],
  in_progress: ['resolved', 'closed'],
  resolved: ['closed', 'in_progress'],
  closed: [],
};

export default function Support() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ kind: 'ok' | 'blocked'; text: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['support'] });

  const list = useQuery({ queryKey: ['support'], queryFn: api.supportList, retry: false });

  const raise = useMutation({
    mutationFn: (body: { subject: string; body: string; channel: string }) => api.supportRaise(body),
    onSuccess: () => { setMessage({ kind: 'ok', text: t('support.raised') }); refresh(); },
    onError: (err) => setMessage({ kind: 'blocked', text: (err instanceof Error && err.message) || t('support.raiseFailed') }),
  });
  const transition = useMutation({
    mutationFn: (v: { id: string; to: string }) => api.supportTransition(v.id, v.to),
    onSuccess: refresh,
    onError: (err) => setMessage({
      kind: 'blocked',
      text: isApiError(err) && err.status === 403 ? t('support.agentOnly') : (err instanceof Error && err.message) || t('support.transitionFailed'),
    }),
  });

  return (
    <Panel title={t('support.title')} state={list.isPending ? 'loading' : 'ready'}>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          raise.mutate({
            subject: String(f.get('subject') ?? '').trim(),
            body: String(f.get('body') ?? '').trim(),
            channel: String(f.get('channel')),
          });
          e.currentTarget.reset();
        }}
      >
        <Input name="subject" placeholder={t('support.subject')} required />
        <Input name="body" placeholder={t('support.details')} />
        <Select name="channel">
          <option value="in_app">{t('support.inApp')}</option>
          <option value="email">{t('support.email')}</option>
        </Select>
        <Button type="submit" disabled={raise.isPending}>{t('support.raise')}</Button>
      </form>
      <Msg kind={message?.kind}>{message?.text}</Msg>

      {list.isPending ? <Loading /> : list.isError ? <ErrorPanel message={t('support.error')} /> : (
        <>
          <p className="text-ink-muted text-sm">{t('support.showing', { scope: list.data.scope })}</p>
          <ul className="list-none p-0">
            {list.data.tickets.length === 0 && <li className="text-ink-muted">{t('support.none')}</li>}
            {list.data.tickets.map((tk) => (
              <li key={tk.id} className="py-1.5 border-b border-line flex flex-wrap items-center gap-2">
                <span>#{tk.id.slice(0, 8)} — {tk.subject} <strong>[{tk.status}]</strong></span>
                {(NEXT[tk.status] ?? []).map((to) => (
                  <GhostButton key={to} onClick={() => transition.mutate({ id: tk.id, to })} disabled={transition.isPending}>
                    {to.replace('_', ' ')}
                  </GhostButton>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
