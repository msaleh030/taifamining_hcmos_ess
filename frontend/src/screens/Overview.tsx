// C2 — Workforce Overview, the console landing (UNI-01, AUTH-06, KPI-ref).
// KPI strip of navigable .kpi-nav tiles (repeat(4,1fr)) that deep-link to
// their source module, then the mixed bento. Figures come ONLY from certified
// endpoints (the role-scoped scorecard); an unavailable KPI names its missing
// input — never a fabricated number. Bento cards whose aggregates have no
// backend endpoint yet render the designed empty state (backend gap flagged
// on the Kira list — the view layer does not invent data).
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, presentCard, isApiError } from '../lib/api';
import type { Landing } from '../lib/types';
import { Skeleton, EmptyState, ErrorBanner } from '../components/state';
import { IcBell, IcChart, IcUsers } from '../components/icons';

export default function Overview({ landing }: { landing: Landing }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const sc = useQuery({ queryKey: ['scorecard'], queryFn: api.scorecard, retry: false });

  const cards = (sc.data?.enabled && sc.data.cards?.length ? sc.data.cards.slice(0, 4) : []);

  return (
    <div className="grid" data-state={sc.isPending ? 'loading' : 'populated'}>
      {/* KPI strip — navigable tiles, mono figures, each names its source */}
      <div className="sec-h"><h2>{t('overview.kpiStrip')}</h2><span className="ln" /></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        {sc.isPending ? (
          Array.from({ length: 4 }, (_, i) => <div className="card kpi" key={i}><Skeleton rows={2} /></div>)
        ) : cards.length ? (
          cards.map((c) => {
            const p = presentCard(c);
            return (
              <button key={c.name} className="card kpi kpi-nav" style={{ textAlign: 'left' }} onClick={() => navigate('/scorecard')}>
                <div className="lab"><IcChart />{c.name}</div>
                {p.kind === 'value'
                  ? <div className="val num">{p.value}{p.target != null ? <small> / {String(p.target)}</small> : null}</div>
                  : <div className="val" style={{ fontSize: 15, color: 'var(--muted)' }}>{t('kpi.naCard')} — {p.reason}</div>}
                <div className="kpi-src">{t('overview.viewScorecard')}</div>
              </button>
            );
          })
        ) : (
          // No scorecard for this role / flag off — the strip stays navigational.
          [
            { label: t('employees.directory'), icon: <IcUsers />, to: '/directory' },
            { label: t('kpi.console'), icon: <IcChart />, to: '/scorecard' },
            { label: t('governance.alerts'), icon: <IcBell />, to: '/alerts' },
            { label: t('leave.liability'), icon: <IcChart />, to: '/liability' },
          ].map((x) => (
            <button key={x.to} className="card kpi kpi-nav" style={{ textAlign: 'left' }} onClick={() => navigate(x.to)}>
              <div className="lab">{x.icon}{x.label}</div>
              <div className="val" style={{ fontSize: 15, color: 'var(--muted)' }}>{t('kpi.naCard')}</div>
              <div className="kpi-src">{x.label}</div>
            </button>
          ))
        )}
      </div>
      {sc.isError && !(isApiError(sc.error) && sc.error.status === 403) && (
        <ErrorBanner text={t('overview.errB')} onRetry={() => sc.refetch()} retryLabel={t('overview.retry')} />
      )}

      {/* Mixed bento — 1.4fr / 1fr per the redline */}
      <div className="grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <div className="card">
          <div className="card-h"><h3>{t('overview.activityPanel')}</h3><span className="meta">{t('overview.audit')}</span></div>
          <EmptyState title={t('overview.emptyT')} body={t('overview.emptyB')} />
        </div>
        <div className="card">
          <div className="card-h"><h3>{t('overview.approvalsPanel')}</h3></div>
          <EmptyState title={t('overview.emptyT')} body={t('overview.emptyB')} />
        </div>
      </div>
      <p className="note">{landing.role === 'R14' ? t('overview.execBanner') : t('overview.scopeNote')}</p>
    </div>
  );
}
