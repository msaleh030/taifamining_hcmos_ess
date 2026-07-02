// F4 — KPI cards (port of kpi.js). Each card shows its RAG status and
// value/target, OR a NOT-AVAILABLE card naming the missing input (never a zero
// or a guessed %). FOUR distinct render states, never a blank fall-through,
// each carrying a unique data-state so they can never be confused:
//   • module-disabled — analytics.enabled OFF (TENANT-WIDE, overrides role):
//     a whole-module panel EXPLAINING it is off + an enable-pointer.
//   • no-permission   — the requester is not allowed the module (endpoint 403).
//   • empty           — flag on, allowed, but no cards to show.
//   • ready           — flag on, cards present.
// NOTE (Kira's spot-check): My KPIs is the lightest-covered spec entry — its
// bento redline is confirmed with Design before the visual-parity pass on this
// screen; the behaviour below is the certified functional AC either way.
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, presentCard, isApiError } from '../lib/api';
import type { KpiCard, KpiPayload } from '../lib/types';
import { Panel, ErrorPanel } from '../components/ui';

function Card({ card }: { card: KpiCard }) {
  const { t } = useTranslation();
  const p = presentCard(card);
  if (p.kind === 'not-available') {
    return (
      <div data-state="not-available" className="bg-surface-raised border border-line rounded-card p-3">
        <h4 className="font-semibold">{card.name}</h4>
        <p><em>{t('kpi.notAvailable')}</em> — {p.reason}</p>
      </div>
    );
  }
  const rag = p.rag || 'grey';
  const ragColor = { green: 'text-rag-green', amber: 'text-rag-amber', red: 'text-rag-red' }[rag] ?? 'text-rag-grey';
  return (
    <div data-rag={rag} className="bg-surface-raised border border-line rounded-card p-3">
      <h4 className="font-semibold">{card.name}</h4>
      <p className="text-xl">{p.value}{p.target != null ? ` / ${p.target}` : ''}</p>
      <p className={`font-semibold ${ragColor}`}>{rag.toUpperCase()}</p>
    </div>
  );
}

// Pure: a {enabled, cards} payload → view. Flag-off (enabled:false) ALWAYS
// wins, regardless of role/cards — the tenant-wide disabled panel.
export function KpiModule({ payload, title }: { payload: KpiPayload; title: string }) {
  const { t } = useTranslation();
  if (!payload || !payload.enabled) {
    return (
      <Panel title={title} state="module-disabled">
        <p>{t('kpi.moduleOff', { title })}</p>
        <p className="text-ink-muted">{t('kpi.enablePointer')}</p>
      </Panel>
    );
  }
  const cards = payload.cards ?? [];
  if (cards.length === 0) {
    return <Panel title={title} state="empty"><p className="text-ink-muted">{t('kpi.empty')}</p></Panel>;
  }
  return (
    <Panel title={title} state="ready">
      <div className="grid gap-3 grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]">
        {cards.map((c) => <Card key={c.name} card={c} />)}
      </div>
    </Panel>
  );
}

function KpiScreen({ queryKey, fetch, title, errorKey }: {
  queryKey: string; fetch: () => Promise<KpiPayload>; title: string; errorKey: string;
}) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: [queryKey], queryFn: fetch, retry: false });
  if (q.isPending) return <Panel title={title} state="loading"><p className="text-ink-muted">…</p></Panel>;
  if (q.isError) {
    return isApiError(q.error) && q.error.status === 403
      ? <Panel title={title} state="no-permission"><p>{t('kpi.noPermission', { title })}</p></Panel>
      : <ErrorPanel message={t(errorKey)} />;
  }
  return <KpiModule payload={q.data} title={title} />;
}

export function Scorecard() {
  const { t } = useTranslation();
  return <KpiScreen queryKey="scorecard" fetch={api.scorecard} title={t('kpi.scorecard')} errorKey="kpi.error.scorecard" />;
}

export function MyKpis() {
  const { t } = useTranslation();
  return <KpiScreen queryKey="my-kpis" fetch={api.myKpis} title={t('kpi.mine')} errorKey="kpi.error.mine" />;
}
