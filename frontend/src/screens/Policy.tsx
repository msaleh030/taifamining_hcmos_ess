// F7 — policy acknowledgement (port of policy.js, POL-02/03; self-service).
// Every employee reads the current policy version and acknowledges it; a new
// version re-opens the ack. Publishing (POL-01) and the outstanding report
// (POL-04) are admin/compliance endpoints, not part of this employee screen.
import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, Input, Msg, Panel, ErrorPanel, Loading } from '../components/ui';

export default function Policy() {
  const { t } = useTranslation();
  const [code, setCode] = useState('COND');
  const [message, setMessage] = useState<{ kind: 'ok' | 'blocked'; text: string } | null>(null);
  const [acked, setAcked] = useState(false);

  const policy = useQuery({
    queryKey: ['policy', code],
    queryFn: () => api.policyRead(code),
    retry: false,
  });

  const ack = useMutation({
    mutationFn: () => api.policyAck(code),
    onSuccess: (r) => { setMessage({ kind: 'ok', text: t('policy.acked', { version: r.version }) }); setAcked(true); },
    onError: (err) => setMessage({ kind: 'blocked', text: (err instanceof Error && err.message) || t('policy.ackFailed') }),
  });

  return (
    <Panel title={t('policy.title')} state="ready">
      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setMessage(null);
          setAcked(false);
          setCode(String(new FormData(e.currentTarget).get('code') ?? '').trim());
        }}
      >
        <Input name="code" defaultValue={code} placeholder={t('policy.code')} />
        <Button type="submit">{t('policy.open')}</Button>
      </form>

      {policy.isPending ? <Loading /> : policy.isError ? (
        <ErrorPanel message={isApiError(policy.error) && policy.error.status === 404
          ? t('policy.notFound', { code }) : t('policy.error')} />
      ) : (
        <article data-state="ready">
          <h4 className="font-semibold">
            {policy.data.title} <span className="text-ink-muted text-sm">v{policy.data.version}</span>
          </h4>
          <div className="whitespace-pre-wrap my-3">{policy.data.body ?? ''}</div>
          <Button onClick={() => ack.mutate()} disabled={acked || ack.isPending}>
            {t('policy.ack', { version: policy.data.version })}
          </Button>
          <Msg kind={message?.kind}>{message?.text}</Msg>
        </article>
      )}
    </Panel>
  );
}
