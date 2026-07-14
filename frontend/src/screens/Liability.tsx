// C16 — Payroll / leave liability (LIAB-01/02/03, EX-2, PC-1). The money
// register: .ltable (name · days · daily rate · liability, right-set mono),
// dimmed excluded leaver rows, .lna chips NAMING the missing input (never a
// silent zero), and the .ltotal footer with the big mono total + the PC-1
// formula chip (daily = leave-pay base ÷ 30, EX-2 base exclusions). Guarded
// to pay-visibility roles — a refusal renders the designed no-permission
// state with the why chip.
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Skeleton, ErrorBanner, NoPermission, EmptyState } from '../components/state';
import { IcSearch, IcBanknote } from '../components/icons';

export default function Liability() {
  const { t } = useTranslation();
  const [batchId, setBatchId] = useState('');

  const res = useQuery({
    queryKey: ['liability', batchId],
    queryFn: () => api.liabilityBatch(batchId),
    enabled: !!batchId,
    retry: false,
  });

  return (
    <div className="grid">
      <form className="sitefilter" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setBatchId(String(new FormData(e.currentTarget).get('batch') ?? '').trim());
      }}>
        <label className="search" style={{ margin: 0, width: 320 }}>
          <IcSearch />
          <input name="batch" placeholder={t('leave.selectPeriod')} required />
        </label>
        <button className="btn primary" type="submit">{t('leave.registerTitle')}</button>
      </form>

      {!batchId ? (
        <div className="card"><EmptyState title={t('leave.emptyLiabTitle')} body={t('leave.emptyLiabBody')} icon={<IcBanknote />} /></div>
      ) : res.isPending ? (
        <div className="card card-p"><Skeleton rows={6} /></div>
      ) : res.isError ? (
        isApiError(res.error) && res.error.status === 403
          ? <NoPermission title={t('leave.noPermTitle')} body={t('leave.noPermBody')} why={t('leave.noPermWhy')} />
          : <ErrorBanner text={t('leave.errLiabBody')} onRetry={() => res.refetch()} retryLabel={t('leave.retry')} />
      ) : (
        <div className="grid" data-state="populated">
          <div className="ltable">
            <div className="lhead">
              <span>{t('leave.colStaff')}</span>
              <span className="hide" style={{ textAlign: 'right' }}>{t('leave.colDays')}</span>
              <span className="hide" style={{ textAlign: 'right' }}>{t('leave.colDaily')}</span>
              <span style={{ textAlign: 'right' }}>{t('leave.colLiab')}</span>
            </div>
            {res.data.available.map((a) => (
              <div className="lrow" key={a.employee_id}>
                <span className="who"><span className="nm num">{a.employee_id}</span></span>
                <span className="num hide">{a.days}</span>
                <span className="num hide">{a.daily_rate}</span>
                <span className="num liab">{a.liability}</span>
              </div>
            ))}
            {(res.data.not_available ?? []).map((n) => (
              <div className="lrow" key={n.employee_id} data-state="not-available">
                <span className="who"><span className="nm num">{n.employee_id}</span></span>
                <span className="hide" />
                <span className="hide" />
                <span style={{ textAlign: 'right' }}><span className="lna">{t('leave.notAvail')} · {n.missing}</span></span>
              </div>
            ))}
            {(res.data.excluded ?? []).map((x) => (
              <div className="lrow excl" key={x.employee_id}>
                <span className="who"><span className="nm num">{x.employee_id}</span><span className="rl">{x.status}</span></span>
                <span className="hide" />
                <span className="hide" />
                <span className="liab">{t('leave.exclLeaver')}</span>
              </div>
            ))}
            {res.data.available.length === 0 && (res.data.not_available ?? []).length === 0 && (
              <EmptyState title={t('leave.emptyLiabTitle')} body={t('leave.emptyLiabBody')} />
            )}
          </div>
          <div className="ltotal">
            <div>
              <div className="tk">{t('leave.totalTitle')}</div>
              <div className="tv">{String(res.data.total)}</div>
            </div>
            <div className="tmeta">
              <span className="formula">{t('leave.dailyFormula')}</span><br />
              {t('leave.activeOnly')} · {t('leave.exBase')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
