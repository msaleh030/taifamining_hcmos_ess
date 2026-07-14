// E4 — Apply leave (LV-01/02/05, LR-1/2/5/7). Balance tiles (annual hi /
// sick / carry), segmented leave-type tiles that fill with the type's
// semantic colour, the .fg form and the submission-check vocabulary. The
// RULES LIVE SERVER-SIDE: over-balance / overlap / >14-continuous refusals
// come back from the endpoint and render as the tripped .chk row with the
// Head-of-HR exception panel (.hoh) — the client never re-implements a rule.
// Sick is the SEPARATE 63+63 bucket with certificate required from day one
// (LR-7); an unconfigured sick limit shows as not-available NAMING the
// missing input. Carry wording follows the certified v1.5 rule (10-day cap
// at anniversary, +3-month forfeit) — the spec's 1-year-lapse line is stale
// and flagged for doc correction.
import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Skeleton, ErrorBanner, Seal } from '../components/state';
import { IcCalendar, IcAlert, IcCheck } from '../components/icons';

export default function Leave({ ess }: { ess?: boolean } = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [type, setType] = useState<'annual' | 'sick'>('annual');
  const [blocked, setBlocked] = useState<string | null>(null);
  const [hoh, setHoh] = useState(false);
  const [done, setDone] = useState(false);

  const bal = useQuery({ queryKey: ['leave-balance'], queryFn: api.leaveBalance, retry: false });
  const apply = useMutation({
    mutationFn: (v: { leave_type: string; days: number; hoh_override: boolean }) => api.leaveApply(v),
    onSuccess: () => {
      setBlocked(null); setHoh(false); setDone(true);
      queryClient.invalidateQueries({ queryKey: ['leave-balance'] });
    },
    onError: (err: Error) => setBlocked(err.message || t('leave.errApplyBody')),
  });

  if (bal.isPending) return <div className="card card-p"><Skeleton rows={5} /></div>;
  if (bal.isError) return <ErrorBanner text={t('leave.errApplyBody')} onRetry={() => bal.refetch()} retryLabel={t('leave.retry')} />;
  const b = bal.data;
  const sickNa = typeof b.sick.available === 'object' && b.sick.available.available === false ? b.sick.available : null;

  if (done) {
    return (
      <div className="card card-p">
        <Seal title={t('leave.successApplyTitle')} sub={t('leave.successApplySub')} />
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <button className="btn" onClick={() => setDone(false)}>{t('leave.close')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className={ess ? 'body' : 'grid'} data-state={blocked ? 'error' : 'populated'}>
      {/* balance tiles */}
      <div className="tiles">
        <div className="tile hi">
          <span className="tl"><IcCalendar style={{ width: 13, height: 13 }} />{t('leave.annualTitle')}</span>
          <span className="big num">{b.annual.available}<small> {t('leave.dayU')}</small></span>
          <span className="sub">{t('leave.entitlement')} {b.annual.entitlement} · {t('leave.taken')} {b.annual.taken}</span>
        </div>
        <div className="tile sick">
          <span className="tl">{t('leave.sickTitle')}</span>
          {sickNa
            ? <><span className="big num">—</span><span className="sub"><em>{t('leave.notAvail')}</em> — {sickNa.missing}</span></>
            : <><span className="big num">{String(b.sick.available)}</span><span className="sub">{t('leave.sickSplit')} · {t('leave.sickCertRule')}</span></>}
        </div>
        <div className="tile carry">
          <span className="tl">{t('leave.carryTitle')}</span>
          <span className="big num">{b.annual.carried}<small> {t('leave.dayU')}</small></span>
          <span className="sub">{t('leave.carryRule', { defaultValue: 'Capped at 10 days at your employment anniversary; unused carry forfeits 3 months after. Opening balances are protected.' })}</span>
        </div>
      </div>

      {/* leave type — segmented tiles fill with the type's colour */}
      <div className="ltypes">
        <button type="button" className={`ltype${type === 'annual' ? ' sel-a' : ''}`} onClick={() => setType('annual')}>
          <span className="li"><IcCalendar /></span>
          <span><span className="tt">{t('leave.tAnnual')}</span><br /><span className="td">{t('leave.tAnnualD')}</span></span>
          <span className="rad" />
        </button>
        <button type="button" className={`ltype${type === 'sick' ? ' sel-s' : ''}`} onClick={() => setType('sick')}>
          <span className="li"><IcAlert /></span>
          <span><span className="tt">{t('leave.tSick')}</span><br /><span className="td">{t('leave.tSickD')}</span></span>
          <span className="rad" />
        </button>
      </div>

      <form className="card card-p" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        apply.mutate({ leave_type: type, days: Number(f.get('days')), hoh_override: hoh });
      }}>
        <div className="fg">
          <div className="field">
            <label>{t('leave.reqDays')} <span className="req">*</span></label>
            <input name="days" type="number" min={0.5} step={0.5} required />
          </div>
          <div className="field">
            <label>{t('leave.reason')}</label>
            <input name="reason" placeholder={t('leave.reasonPH')} />
          </div>
        </div>
        {type === 'sick' && <div className="note" style={{ marginTop: 8 }}><IcAlert style={{ width: 13, height: 13 }} />{t('leave.certReq')}</div>}

        {/* submission checks — the SERVER'S verdict, rendered in the check vocabulary */}
        {blocked && (
          <div className="checks" style={{ marginTop: 12 }}>
            <div className="chk bad">
              <span className="ci"><IcAlert style={{ width: 14, height: 14 }} /></span>
              <span><span className="ct">{t('leave.errApplyTitle')}</span><br /><span className="cd">{blocked}</span></span>
            </div>
            <div className="hoh">
              <IcAlert style={{ width: 14, height: 14 }} />
              <span><b>{t('leave.hohTitle')}</b> {t('leave.hohBody')}
                <label style={{ display: 'flex', gap: 7, alignItems: 'center', marginTop: 7, fontWeight: 600 }}>
                  <input type="checkbox" checked={hoh} onChange={(e) => setHoh(e.target.checked)} /> {t('leave.routeHoH')}
                </label>
              </span>
            </div>
          </div>
        )}
        {!blocked && apply.isSuccess === false && apply.isIdle && (
          <div className="checks" style={{ marginTop: 12 }}>
            <div className="chk ok">
              <span className="ci"><IcCheck style={{ width: 14, height: 14 }} /></span>
              <span><span className="ct">{t('leave.checksTitle')}</span><br /><span className="cd">{t('leave.chkBalance')} · {t('leave.chkOverlap')} · {t('leave.chkContinuous')}</span></span>
            </div>
          </div>
        )}
        <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
          <button className="btn primary" type="submit" disabled={apply.isPending}>{t('leave.submitApply')}</button>
        </div>
      </form>
    </div>
  );
}
