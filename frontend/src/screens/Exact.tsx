// C18 — Exact integration (EXACT-01..10, LVR-02, PRT-02). The pipeline:
// Upload → Schema → Reconcile → Control-totals → Publish drawn as the .pipe
// stepper with done/active/fail/partial nodes. THE SAFETY NET IS THE SCREEN:
// a schema-fail (422) renders the offending-rows list and BLOCKS — nothing
// ingested; a control-totals delta renders the red .ctrow and BLOCKS publish;
// there is no click-past on either. Match is on the LEGACY staff number, not
// the new TMCL number. Partial publish shows per-leg status (GL / ESS) and
// re-pushes ONLY the failed leg — the GL is never re-posted (no double-post).
// WORDING IS LAW: Total Pay and Net Pay = Total Pay − Total Deduction; the
// Exact file's own header is referenced only as the source column.
import { useState, type DragEvent, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { ExactPublishOut, ExactReconcileOut, ControlTotalsOut } from '../lib/types';
import { ErrorBanner, NoPermission, Seal } from '../components/state';
import { IcAlert, IcCheck, IcUpload, IcUsers } from '../components/icons';

type Stage = 'upload' | 'staged' | 'reconciled' | 'totals' | 'published';

export default function Exact() {
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>('upload');
  const [batchId, setBatchId] = useState<string | null>(null);
  const [schemaErrors, setSchemaErrors] = useState<string[] | null>(null);
  const [recon, setRecon] = useState<ExactReconcileOut | null>(null);
  const [totals, setTotals] = useState<ControlTotalsOut | null>(null);
  const [legs, setLegs] = useState<ExactPublishOut['legs'] | null>(null);
  const [publishBlock, setPublishBlock] = useState<string | null>(null);
  const [noPerm, setNoPerm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csv, setCsv] = useState('');

  const gate = (err: unknown) => {
    if (isApiError(err) && err.status === 403) { setNoPerm(true); return true; }
    return false;
  };

  if (noPerm) return <NoPermission title={t('exact.noPermExactTitle')} body={t('exact.noPermExactBody')} why={t('exact.noPermExactWhy')} />;

  const failed = legs ? Object.values(legs).some((r: { status: string }) => r.status !== 'posted') : false;
  const steps: { key: string; label: string; state: string }[] = [
    { key: '1', label: t('exact.pUpload'), state: stage === 'upload' ? (schemaErrors ? 'fail active' : 'active') : 'done' },
    { key: '2', label: t('exact.pSchema'), state: schemaErrors ? 'fail active' : stage === 'upload' ? 'queued' : 'done' },
    { key: '3', label: t('exact.pReconcile'), state: stage === 'staged' ? 'active' : ['reconciled', 'totals', 'published'].includes(stage) ? 'done' : 'queued' },
    { key: '4', label: t('exact.pTotals'), state: totals ? (totals.ok ? 'done' : 'fail active') : stage === 'reconciled' ? 'active' : 'queued' },
    { key: '5', label: t('exact.pPublish'), state: stage === 'published' ? (failed ? 'partial active' : 'done') : publishBlock ? 'fail active' : stage === 'totals' && totals?.ok ? 'active' : 'queued' },
  ];

  return (
    <div className="grid" data-state={schemaErrors ? 'validation-failed' : publishBlock ? 'totals-mismatch' : stage}>
      <div className="card card-p">
        <div className="pipe">
          {steps.map((s) => (
            <div key={s.key} className={`pstep ${s.state}`}>
              <span className="pnode">{s.state.includes('done') ? <IcCheck style={{ width: 14, height: 14 }} /> : s.key}</span>
              <span className="plbl">{s.label}</span>
            </div>
          ))}
        </div>
        <div className="mkey" style={{ marginTop: 12 }}>
          <span className="kk">{t('exact.matchKey')}</span>
          <span className="kv">{t('exact.matchKeyVal')}</span>
          <span className="tag t-blue">{t('exact.matchKeyTag')}</span>
        </div>
      </div>

      {error && <ErrorBanner text={error} onRetry={() => setError(null)} retryLabel={t('exact.retry')} />}

      {stage === 'upload' && (
        <UploadCard csv={csv} setCsv={setCsv} schemaErrors={schemaErrors}
          onStaged={(id) => { setBatchId(id); setSchemaErrors(null); setStage('staged'); }}
          onSchemaFail={(errs) => setSchemaErrors(errs)}
          onGate={gate} onError={(m) => setError(m)} />
      )}

      {stage !== 'upload' && batchId && (
        <>
          {recon && (
            <div className="card card-p">
              <div className="shead">{t('exact.reconTitle')}</div>
              <div className="recon">
                <div className="rbucket">
                  <span className="rbi" style={{ background: 'rgba(31,162,74,.14)', color: 'var(--green)' }}><IcCheck /></span>
                  <span><span className="rt">{t('exact.reconMatched')}</span>
                    <span className="rd" style={{ display: 'block' }}><span className="num">{recon.matched}</span> · {recon.key}</span></span>
                </div>
                {recon.unmatched.length > 0 && (
                  <div className="rbucket unknown">
                    <span className="rbi"><IcAlert /></span>
                    <span style={{ flex: 1 }}>
                      <span className="rt">{t('exact.reconUnknown')} ({recon.unmatched.length})</span>
                      <span className="rd" style={{ display: 'block' }}>{t('exact.reconUnknownD')}</span>
                      <ul className="vlist">{recon.unmatched.map((u) => <li key={u.employee_id} className="num">{u.employee_id}</li>)}</ul>
                    </span>
                  </div>
                )}
                <p className="note">{t('exact.reconNote')}</p>
              </div>
            </div>
          )}

          {totals && <TotalsCard totals={totals} />}

          {publishBlock && (
            <div className="banner err" role="alert" data-state="totals-mismatch">
              <IcAlert /><div><b>{t('exact.ctotFailTitle')}</b> — {publishBlock} {t('exact.blocked')}</div>
            </div>
          )}

          {stage === 'published' && legs ? (
            <PublishCard legs={legs} batchId={batchId} onLegs={(p) => setLegs(p.legs)} />
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={async () => {
                try { setRecon(await api.exactReconcile(batchId)); setStage('reconciled'); }
                catch (err) { if (!gate(err)) setError(t('exact.errExactBody')); }
              }}>{t('exact.pReconcile')}</button>
              <button className="btn" onClick={async () => {
                try { const r = await api.exactControlTotals(batchId); setTotals(r); setStage('totals'); }
                catch (err) { if (!gate(err)) setError(t('exact.errExactBody')); }
              }}>{t('exact.pTotals')}</button>
              <button className="btn primary" disabled={!totals?.ok} onClick={async () => {
                try {
                  const p = await api.exactPublish(batchId);
                  setLegs(p.legs); setPublishBlock(null); setStage('published');
                } catch (err) {
                  if (gate(err)) return;
                  const why = isApiError(err) && (err.body as any)?.mismatches
                    ? (err.body as any).mismatches.map((m: any) => `${m.field}: ${m.declared} ≠ ${m.computed}`).join('; ')
                    : (err instanceof Error && err.message) || '';
                  setPublishBlock(why); // hard block — no click-past
                }
              }}>{t('exact.publishBtn')}</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function UploadCard({ csv, setCsv, schemaErrors, onStaged, onSchemaFail, onGate, onError }: {
  csv: string; setCsv: (s: string) => void; schemaErrors: string[] | null;
  onStaged: (id: string) => void; onSchemaFail: (errs: string[]) => void;
  onGate: (e: unknown) => boolean; onError: (m: string) => void;
}) {
  const { t } = useTranslation();
  const [drag, setDrag] = useState(false);

  const readFile = (file: File) => {
    const r = new FileReader();
    r.onload = () => setCsv(String(r.result ?? ''));
    r.readAsText(file);
  };

  return (
    <form className="card card-p" onSubmit={async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      try {
        const out = await api.exactUpload({
          period: String(f.get('period') ?? '').trim(),
          csv,
          control_totals: {
            gross: String(f.get('gross') ?? '').trim() || null,
            total_deduction: String(f.get('td') ?? '').trim() || null,
            net: String(f.get('net') ?? '').trim() || null,
          },
        });
        onStaged(out.batch_id);
      } catch (err) {
        if (onGate(err)) return;
        if (isApiError(err) && err.status === 422) {
          // Schema-fail: REJECTED, nothing ingested — the block state.
          onSchemaFail(((err.body as any)?.errors as string[]) ?? [err.message]);
        } else onError((err instanceof Error && err.message) || t('exact.errExactBody'));
      }
    }}>
      <div
        className="drop"
        data-drag={drag || undefined}
        style={drag ? { borderColor: 'var(--green)' } : undefined}
        onDragOver={(e: DragEvent) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault(); setDrag(false);
          const file = e.dataTransfer?.files?.[0];
          if (file) readFile(file);
        }}
      >
        <span className="di"><IcUpload /></span>
        <h3>{t('exact.dropTitle')}</h3>
        <p>{t('exact.dropBody')}</p>
        <label className="btn sm" style={{ marginTop: 6 }}>
          {t('exact.dropCta')}
          <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
        </label>
      </div>
      <textarea className="field" value={csv} onChange={(e) => setCsv(e.target.value)}
        rows={5} placeholder={t('exact.dropBody')}
        style={{ width: '100%', marginTop: 10, fontFamily: 'var(--mono)', fontSize: 12 }} />

      <div className="fg" style={{ marginTop: 12 }}>
        <div className="field"><label>{t('exact.reg', { defaultValue: 'Period' })} <span className="req">*</span></label>
          <input name="period" placeholder="2026-06" required /></div>
        <div className="field"><label>{t('exact.ctTotalPay')}</label><input name="gross" inputMode="decimal" /></div>
        <div className="field"><label>{t('exact.ctTotalDed')}</label><input name="td" inputMode="decimal" /></div>
        <div className="field"><label>{t('exact.ctNetPay')}</label><input name="net" inputMode="decimal" /></div>
      </div>
      <p className="note">{t('exact.netDefn')}</p>

      {schemaErrors && (
        <div className="banner err" role="alert" data-state="validation-failed">
          <IcAlert />
          <div style={{ flex: 1 }}>
            <b>{t('exact.schemaFailTitle')}</b> {t('exact.schemaFailBody')}
            <ul className="vlist">{schemaErrors.map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        </div>
      )}
      <button className="btn primary" type="submit" style={{ marginTop: 10 }}>{t('exact.pUpload')}</button>
    </form>
  );
}

function TotalsCard({ totals }: { totals: ControlTotalsOut }) {
  const { t } = useTranslation();
  const FIELD_LABEL: Record<string, string> = {
    gross: t('exact.ctTotalPay'), total_deduction: t('exact.ctTotalDed'), net: t('exact.ctNetPay'),
  };
  return (
    <div className="card card-p">
      <div className="shead">{t('exact.ctotTitle')}</div>
      <div className="ctot">
        <div className="ctrow" style={{ fontWeight: 700, fontSize: 10.5, textTransform: 'uppercase', color: 'var(--faint)' }}>
          <span>{t('exact.colMetric')}</span><span className="num">{t('exact.colFile')}</span>
          <span className="num">{t('exact.colComputed')}</span><span className="num">{t('exact.colDelta')}</span>
        </div>
        {totals.ok ? (
          <div className="ctrow">
            <span>{t('exact.ctNetPay')}</span>
            <span className="num">{totals.computed.net}</span>
            <span className="num">{totals.computed.net}</span>
            <span className="num d0">{t('exact.balanced')}</span>
          </div>
        ) : (
          totals.mismatches.map((m) => (
            <div className="ctrow bad" key={m.field}>
              <span>{FIELD_LABEL[m.field] ?? m.field}</span>
              <span className="num">{m.declared}</span>
              <span className="num">{m.computed}</span>
              <span className="num dx">{t('exact.blocked')}</span>
            </div>
          ))
        )}
      </div>
      {totals.ok
        ? <div className="banner ok" style={{ marginTop: 10 }}><IcCheck />{t('exact.ctotOk')} — {t('exact.ctotOkD')}</div>
        : <div className="banner err" style={{ marginTop: 10 }} role="alert"><IcAlert /><b>{t('exact.ctotFailTitle')}</b> {t('exact.ctotFailBody')}</div>}
    </div>
  );
}

function PublishCard({ legs, batchId, onLegs }: {
  legs: ExactPublishOut['legs']; batchId: string; onLegs: (p: ExactPublishOut) => void;
}) {
  const { t } = useTranslation();
  const failed = Object.values(legs).some((r) => r.status !== 'posted');
  const LEG_LABEL: Record<string, string> = { gl: t('exact.legGl'), ess: t('exact.legEss') };
  return (
    <div className="card card-p" data-state={failed ? 'partial-publish' : 'success'}>
      {failed ? (
        <>
          <div className="banner off"><IcAlert /><div><b>{t('exact.partialTitle')}</b> {t('exact.partialBody')}</div></div>
          <div className="pub">
            {Object.entries(legs).map(([leg, r]) => (
              <div key={leg} className={`pubrow ${r.status === 'posted' ? 'ok' : 'fail'}`} data-leg-status={r.status}>
                <span className="pi">{r.status === 'posted' ? <IcCheck /> : <IcAlert />}</span>
                <span>{LEG_LABEL[leg] ?? leg}</span>
                <span className="num" style={{ marginLeft: 'auto' }}>{r.status === 'posted' ? t('exact.stPosted') : t('exact.stFailed')}</span>
              </div>
            ))}
          </div>
          <p className="note">{t('exact.noRepublish')} — {t('exact.noRepublishB')}</p>
          <button className="btn primary" onClick={async () => onLegs(await api.exactPublishRetry(batchId))}>
            {t('exact.rePushEss')}
          </button>
        </>
      ) : (
        <>
          <Seal title={t('exact.successExactTitle')} sub={t('exact.successExactSub')} />
          <div className="pub" style={{ marginTop: 10 }}>
            <div className="pubrow ok"><span className="pi"><IcCheck /></span>{t('exact.pubPosted')}</div>
            <div className="pubrow ok"><span className="pi"><IcCheck /></span>{t('exact.pubEss')}</div>
            <div className="pubrow ok"><span className="pi"><IcCheck /></span>{t('exact.pubAudit')}</div>
          </div>
        </>
      )}
    </div>
  );
}
