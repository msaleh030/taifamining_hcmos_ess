// C20 — Controls & checker (AUD-01/02/03, SOD-02, LVR-01). Two grids that are
// NEVER conflated: findings (a fail lists its offending records per control)
// and all-clear (every control green WITH its checked-count — provable, not
// asserted: "N checked, 0 offenders"). Gate = Compliance/IT (R11, R12); Head
// of HR is refused — the designed no-permission state says why. The run
// itself is audited.
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { ControlCheck } from '../lib/types';
import { Skeleton, ErrorBanner, NoPermission, EmptyState } from '../components/state';
import { IcAlert, IcCheck, IcShield } from '../components/icons';

const CHECK_KEY: Record<string, [string, string]> = {
  'sod.self_approval': ['governance.ctrlSod', 'governance.ctrlSodD'],
  'attendance.no_location': ['governance.ctrlGps', 'governance.ctrlGpsD'],
  'access.leaver_retained': ['governance.ctrlLeaver', 'governance.ctrlLeaverD'],
  'audit.chain_integrity': ['governance.ctrlChain', 'governance.ctrlChainD'],
};

function ControlCard({ c }: { c: ControlCheck }) {
  const { t } = useTranslation();
  const [nameKey, descKey] = CHECK_KEY[c.check] ?? [c.check, ''];
  return (
    <div className="card card-p" data-check-state={c.pass ? 'ok' : 'fail'}
      style={{ borderLeft: `4px solid ${c.pass ? 'var(--green)' : 'var(--red)'}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span className="kic" style={{ background: c.pass ? 'rgba(31,162,74,.14)' : 'rgba(229,72,77,.14)', color: c.pass ? 'var(--green)' : 'var(--red)', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {c.pass ? <IcCheck /> : <IcAlert />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 13.5 }}>{t(nameKey)}</div>
          {descKey && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{t(descKey)}</div>}
        </div>
        <span className={`tag ${c.pass ? 't-green' : 't-red'}`}>
          <span className="dotbadge" style={{ background: 'currentColor' }} />
          {c.pass ? t('governance.pass') : t('governance.fail')}
        </span>
      </div>
      {/* Evidence line — the checked-count makes the verdict provable. */}
      <div className="num" style={{ marginTop: 10, fontSize: 12, color: c.pass ? 'var(--green)' : 'var(--red)' }}>
        {c.checked} {t('governance.checked')} · {c.offenders.length} {t('governance.offenders')}
      </div>
      {!c.pass && (
        <ul className="vlist" style={{ marginTop: 8 }}>
          {c.offenders.map((o, i) => <li key={i} className="num">{JSON.stringify(o)}</li>)}
        </ul>
      )}
    </div>
  );
}

export default function Controls() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['controls'], queryFn: api.controls, retry: false });

  if (q.isPending) return <div className="card card-p" data-state="loading"><Skeleton rows={5} /></div>;
  if (q.isError) {
    return isApiError(q.error) && q.error.status === 403
      ? <NoPermission title={t('governance.noPermControlsTitle')} body={t('governance.noPermControlsBody')} why={t('governance.noPermControlsWhy')} />
      : <ErrorBanner text={t('governance.errBody')} onRetry={() => q.refetch()} retryLabel={t('governance.retry')} />;
  }
  const r = q.data;
  const checks = r.checks ?? [];
  if (checks.length === 0) return <EmptyState title={t('governance.emptyControlsTitle')} body={t('governance.emptyControlsBody')} icon={<IcShield />} />;

  return (
    <div className="grid" data-state={r.all_pass ? 'all-clear' : 'populated'}>
      {r.all_pass ? (
        <div className="banner ok"><IcCheck /><div><b>{t('governance.allClearTitle')}</b> {t('governance.allClearBody')}</div></div>
      ) : (
        <div className="banner err" role="alert"><IcAlert /><div><b>{t('governance.fail')}</b> — {t('governance.ctrlNote')}</div></div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(2,1fr)' }}>
        {checks.map((c) => <ControlCard key={c.check} c={c} />)}
      </div>
      <p className="note">{t('governance.aud03')}</p>
    </div>
  );
}
