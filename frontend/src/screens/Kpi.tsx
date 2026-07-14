// C3 — KPI Scorecard (KPI-01..04, LIAB-03, LVR-02) and E8 — My KPIs.
// RAG summary bar (.ragbar) whose counts stay internally consistent with the
// cards shown; .kgrid of canonical .kcard tiles (RAG left-border, status
// pill, big mono value, target footer). Four DISTINCT non-populated states,
// never conflated: empty, no-permission, not-available (a card names its
// missing input — never a blank or zero) and flag-off (module disabled,
// greyed panel — tenant-wide, overrides role).
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, presentCard, isApiError } from '../lib/api';
import type { KpiCard, KpiPayload } from '../lib/types';
import { Skeleton, EmptyState, ErrorBanner, NoPermission, Tag } from '../components/state';
import { initials } from '../components/shell';
import { IcChart } from '../components/icons';

const RAG_VAR: Record<string, string> = { green: 'var(--green)', amber: 'var(--yellow)', red: 'var(--red)' };
const RAG_TONE: Record<string, 'green' | 'yellow' | 'red' | 'grey'> = { green: 'green', amber: 'yellow', red: 'red' };

function Card({ card }: { card: KpiCard }) {
  const { t } = useTranslation();
  const p = presentCard(card);
  if (p.kind === 'not-available') {
    return (
      <div className="card kcard card-p" data-state="not-available" style={{ borderLeft: '4px solid var(--faint)' }}>
        <div className="kh">
          <span className="kic"><IcChart /></span>
          <div><div className="knm">{card.name}</div><div className="kfo">{t('kpi.naBecause')}</div></div>
          <span className="kdot" style={{ background: 'var(--faint)' }} />
        </div>
        <div className="kvrow">
          <span className="kv" style={{ fontSize: 16, color: 'var(--muted)' }}>{t('kpi.naCard')}</span>
          <Tag tone="grey">{t('kpi.stNa')}</Tag>
        </div>
        <div className="ktgt"><span className="ktl">{t('kpi.naRule')}</span><span className="ktv">{p.reason}</span></div>
      </div>
    );
  }
  const rag = p.rag ?? 'grey';
  return (
    <div className="card kcard card-p" data-rag={rag} style={{ borderLeft: `4px solid ${RAG_VAR[rag] ?? 'var(--faint)'}` }}>
      <div className="kh">
        <span className="kic"><IcChart /></span>
        <div><div className="knm">{card.name}</div></div>
        <span className="kdot" style={{ background: RAG_VAR[rag] ?? 'var(--faint)' }} />
      </div>
      <div className="kvrow">
        <span className="kv">{String(p.value)}</span>
        <Tag tone={RAG_TONE[rag] ?? 'grey'}>{rag === 'green' ? t('kpi.stOn') : rag === 'amber' ? t('kpi.stWatch') : rag === 'red' ? t('kpi.stOff') : t('kpi.stMon')}</Tag>
      </div>
      {p.target != null && (
        <div className="ktgt"><span className="ktl">{t('kpi.kTarget')}</span><span className="ktv">{String(p.target)}</span></div>
      )}
    </div>
  );
}

function ScorecardBody({ payload, personal }: { payload: KpiPayload; personal?: boolean }) {
  const { t } = useTranslation();
  // flag-off ALWAYS wins — module disabled tenant-wide, distinct from empty.
  if (!payload.enabled) {
    return (
      <div className="card card-p" data-state="flag-off" style={{ opacity: .75 }}>
        <span className="flag"><span className="dot" />{t('kpi.foTag')}</span>
        <h3 style={{ margin: '10px 0 4px' }}>{t('kpi.foTitle')}</h3>
        <p className="muted" style={{ margin: 0 }}>{t('kpi.foBody')}</p>
        <p className="muted" style={{ fontSize: 12 }}>{t('kpi.foProv')} <span className="num">{t('kpi.foProvPath')}</span></p>
      </div>
    );
  }
  const cards = payload.cards ?? [];
  if (cards.length === 0) return <EmptyState title={t('kpi.emptyTitle')} body={t('kpi.emptyBody')} icon={<IcChart />} />;

  const counts = { on: 0, watch: 0, off: 0, na: 0 };
  for (const c of cards) {
    const p = presentCard(c);
    if (p.kind === 'not-available') counts.na++;
    else if (p.rag === 'green') counts.on++;
    else if (p.rag === 'amber') counts.watch++;
    else if (p.rag === 'red') counts.off++;
    else counts.na++;
  }
  return (
    <div className="grid" data-state="populated">
      <div className="ragbar">
        <span className="ragpill g"><span className="ragdot g" />{t('kpi.sumOn')} <span className="n">{counts.on}</span></span>
        <span className="ragpill a"><span className="ragdot a" />{t('kpi.sumWatch')} <span className="n">{counts.watch}</span></span>
        <span className="ragpill r"><span className="ragdot r" />{t('kpi.sumOff')} <span className="n">{counts.off}</span></span>
        <span className="ragpill na"><span className="ragdot na" />{t('kpi.sumNa')} <span className="n">{counts.na}</span></span>
        <span className="scope" style={{ marginLeft: 'auto' }}>{personal ? t('kpi.myScope') : t('kpi.scopeLbl')}</span>
      </div>
      <div className="kgrid" style={personal ? { gridTemplateColumns: '1fr' } : undefined}>
        {cards.map((c) => <Card key={c.name} card={c} />)}
      </div>
      <p className="note">{t('kpi.lvrNote')}</p>
    </div>
  );
}

function KpiScreen({ queryKey, fetch, personal }: { queryKey: string; fetch: () => Promise<KpiPayload>; personal?: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: [queryKey], queryFn: fetch, retry: false });
  if (q.isPending) return <div className="card card-p"><Skeleton rows={5} /></div>;
  if (q.isError) {
    return isApiError(q.error) && q.error.status === 403
      ? <NoPermission title={t('kpi.noPermTitle')} body={t('kpi.noPermBody')} why={t('kpi.noPermWhy')} />
      : <ErrorBanner text={t('kpi.errBody')} onRetry={() => q.refetch()} retryLabel={t('kpi.retry')} />;
  }
  return <ScorecardBody payload={q.data} personal={personal} />;
}

export function Scorecard() {
  return <KpiScreen queryKey="scorecard" fetch={api.scorecard} />;
}

// E8 — personal role-scoped set over the .myhead identity strip.
export function MyKpis({ ess }: { ess?: boolean } = {}) {
  const { t } = useTranslation();
  const landing = useQuery({ queryKey: ['landing'], queryFn: api.landing, retry: false });
  const name = landing.data?.name ?? '';
  return (
    <div className={ess ? 'body' : undefined} style={ess ? undefined : {}}>
      <div className="shiftbar" style={{ marginBottom: 14 }}>
        <span className="av">{initials(name || '·')}</span>
        <div><div className="nm">{name}</div><div className="mt">{landing.data?.role ?? ''} · {t('kpi.myScope')}</div></div>
      </div>
      <KpiScreen queryKey="my-kpis" fetch={api.myKpis} personal />
    </div>
  );
}
