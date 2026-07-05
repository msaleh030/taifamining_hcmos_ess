// E7 — Policy read & acknowledge (POL-02/03), self-service. The current
// version renders as a policy card; acknowledging is version-bound and a new
// version re-opens the ack (the re-ack banner). Publishing (POL-01) and the
// outstanding report (POL-04) are admin/compliance endpoints, guarded
// server-side and out of this employee-facing surface.
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Skeleton, ErrorBanner, EmptyState } from '../components/state';
import { IcCheck, IcFile, IcSearch } from '../components/icons';

export default function Policy() {
  const { t } = useTranslation();
  const [code, setCode] = useState('COND');
  const [acked, setAcked] = useState<string | null>(null);

  const policy = useQuery({ queryKey: ['policy', code], queryFn: () => api.policyRead(code), retry: false });
  const ack = useMutation({
    mutationFn: () => api.policyAck(code),
    onSuccess: (r) => setAcked(String(r.version)),
  });

  return (
    <div className="grid" style={{ maxWidth: 720 }}>
      <form className="sitefilter" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setAcked(null);
        setCode(String(new FormData(e.currentTarget).get('code') ?? '').trim());
      }}>
        <label className="search" style={{ margin: 0, width: 260 }}>
          <IcSearch />
          <input name="code" defaultValue={code} placeholder={t('governance.polTitle')} />
        </label>
        <button className="btn" type="submit">{t('governance.polRead')}</button>
      </form>

      {policy.isPending ? (
        <div className="card card-p"><Skeleton rows={5} /></div>
      ) : policy.isError ? (
        isApiError(policy.error) && policy.error.status === 404
          ? <div className="card"><EmptyState title={t('governance.emptyPolicyTitle')} body={t('governance.emptyPolicyBody')} icon={<IcFile />} /></div>
          : <ErrorBanner text={t('governance.errBody')} onRetry={() => policy.refetch()} retryLabel={t('governance.retry')} />
      ) : (
        <div className="card" data-state={acked ? 'success' : 'populated'}>
          <div className="card-h">
            <h3>{policy.data.title}</h3>
            <span className="meta num">{t('governance.polVersion')} v{policy.data.version}</span>
          </div>
          <div className="card-p" style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.6 }}>
            {policy.data.body ?? ''}
          </div>
          <div className="card-p" style={{ borderTop: '1px solid var(--border-2)' }}>
            {acked ? (
              <div className="banner ok" style={{ margin: 0 }}>
                <IcCheck /><div><b>{t('governance.ackDone')}</b> — {t('governance.ackedLbl')} v{acked}. {t('governance.trackedNote')}</div>
              </div>
            ) : (
              <>
                <label className="note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked readOnly /> {t('governance.ackChk')}
                </label>
                <button className="btn primary" style={{ marginTop: 10 }} disabled={ack.isPending} onClick={() => ack.mutate()}>
                  {t('governance.ackBtn')}
                </button>
                {ack.isError && <ErrorBanner text={(ack.error as Error)?.message || t('governance.errBody')} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
