// F6 — Exact payroll integration (port of exact.js; pay-guarded). Drives the
// pipeline: upload → schema-validate → reconcile → net-check → control-totals
// → publish. The SAFETY NETS are blocking states, never warnings:
//   • a schema-invalid file is REJECTED at upload (422) — nothing is ingested;
//   • control totals that don't reconcile BLOCK publish (409) — no click-past;
//   • a published batch is READ-ONLY (no mutation of pay is offered);
//   • per-leg fan-out status (GL / ESS) with retry SCOPED to failed legs —
//     never a full re-publish, which could double-post the GL.
// Wording: gross/net are presented as pay totals; 'TOTAL ALLOWANCE' appears
// ONLY as the name of the Exact file's source column (v1.5: col 28 is GROSS).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { ExactPublishOut, LegStatus } from '../lib/types';
import { Button, GhostButton, Input, Msg, Panel } from '../components/ui';

type Message = { kind: 'ok' | 'blocked' | 'info'; text: string } | null;

function Legs({ legs, batchId, onLegs }: { legs: Record<string, LegStatus>; batchId: string; onLegs: (p: ExactPublishOut) => void }) {
  const { t } = useTranslation();
  const label: Record<string, string> = { gl: t('exact.legGl'), ess: t('exact.legEss') };
  const failed = Object.values(legs).some((r) => r.status !== 'posted');
  return (
    <div data-state={failed ? 'legs-partial' : 'legs-posted'}>
      <p className="text-ok font-semibold">{t('exact.published')}</p>
      <ul className="list-none p-0">
        {Object.entries(legs).map(([leg, r]) => (
          <li key={leg} data-leg-status={r.status} className={r.status === 'posted' ? 'text-ok' : 'text-danger'}>
            {label[leg] ?? leg}: <strong>{r.status}</strong>{r.error ? ` — ${r.error}` : ''}
          </li>
        ))}
      </ul>
      {failed ? (
        <Button onClick={async () => onLegs(await api.exactPublishRetry(batchId))}>{t('exact.retryLegs')}</Button>
      ) : (
        <p>{t('exact.allLegs')}</p>
      )}
    </div>
  );
}

function Pipeline({ batchId }: { batchId: string }) {
  const { t } = useTranslation();
  const [out, setOut] = useState<JSX.Element | null>(null);
  const [published, setPublished] = useState(false);

  const renderLegs = (p: ExactPublishOut) =>
    setOut(<Legs legs={p.legs} batchId={batchId} onLegs={renderLegs} />);

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <GhostButton onClick={async () => {
          const rep = await api.exactReconcile(batchId);
          setOut(
            <div>
              <p>{t('exact.matched', { n: rep.matched, key: rep.key })}</p>
              {rep.unmatched.length ? (
                <>
                  <p className="text-warn">{t('exact.unmatched', { n: rep.unmatched.length })}</p>
                  <ul className="list-disc pl-5">{rep.unmatched.map((u) => <li key={u.employee_id}>{u.employee_id}</li>)}</ul>
                </>
              ) : <p>{t('exact.allMatched')}</p>}
            </div>,
          );
        }}>{t('exact.reconcile')}</GhostButton>

        <GhostButton onClick={async () => {
          const r = await api.exactNetCheck(batchId);
          setOut(r.mismatches.length
            ? <p className="text-warn">{t('exact.netMismatch', { rows: r.mismatches.map((m) => m.row_no).join(', ') })}</p>
            : <p>{t('exact.netPassed', { n: r.checked })}</p>);
        }}>{t('exact.netCheck')}</GhostButton>

        <GhostButton onClick={async () => {
          const r = await api.exactControlTotals(batchId);
          setOut(r.ok
            ? <p>{t('exact.totalsOk', { net: r.computed.net })}</p>
            : <p className="text-danger font-semibold">{t('exact.totalsBlock', {
                detail: r.mismatches.map((m) => `${m.field} declared ${m.declared} vs computed ${m.computed}`).join('; ') })}</p>);
        }}>{t('exact.controlTotals')}</GhostButton>

        <Button disabled={published} onClick={async () => {
          try {
            const p = await api.exactPublish(batchId);
            setPublished(true); // read-only after publish
            renderLegs(p);
          } catch (err) {
            // Totals mismatch / pending match are BLOCKS, not warnings.
            const why = isApiError(err) && (err.body as any)?.mismatches
              ? ': ' + (err.body as any).mismatches.map((m: any) => `${m.field} ${m.declared}≠${m.computed}`).join('; ')
              : (err instanceof Error && err.message ? ': ' + err.message : '');
            setOut(<p className="text-danger font-semibold" data-state="publish-blocked">{t('exact.publishBlocked', { why })}</p>);
          }
        }}>{t('exact.publish')}</Button>
      </div>
      <div className="mt-3">{out}</div>
    </div>
  );
}

export default function Exact() {
  const { t } = useTranslation();
  const [message, setMessage] = useState<Message>(null);
  const [batchId, setBatchId] = useState<string | null>(null);

  return (
    <Panel title={t('exact.title')} state="ready">
      <form
        className="grid gap-2 max-w-2xl"
        onSubmit={async (e) => {
          e.preventDefault();
          setBatchId(null);
          const f = new FormData(e.currentTarget);
          const control_totals = {
            gross: String(f.get('gross') ?? '').trim() || null, // v1.5: col 28 is GROSS
            total_deduction: String(f.get('td') ?? '').trim() || null,
            net: String(f.get('net') ?? '').trim() || null,
          };
          try {
            const out = await api.exactUpload({
              period: String(f.get('period') ?? '').trim(),
              csv: String(f.get('csv') ?? ''),
              control_totals,
            });
            setBatchId(out.batch_id);
            setMessage({ kind: 'ok', text: t('exact.staged', { id: out.batch_id, rows: out.row_count }) + (out.deduped ? ` ${t('exact.deduped')}` : '') });
          } catch (err) {
            // Schema-fail is a BLOCK: the file is rejected, nothing ingested.
            const details = isApiError(err) && (err.body as any)?.errors ? ': ' + (err.body as any).errors.join('; ') : '';
            setMessage({
              kind: 'blocked',
              text: isApiError(err) && err.status === 422
                ? t('exact.rejected', { details })
                : (err instanceof Error && err.message) || t('exact.uploadFailed'),
            });
          }
        }}
      >
        <Input name="period" placeholder={t('exact.period')} />
        <textarea name="csv" rows={6} placeholder={t('exact.csv')}
          className="px-3 py-2 rounded-control border border-line bg-surface-raised font-mono text-sm" />
        <fieldset className="border border-line rounded-card p-3 grid gap-2">
          <legend className="px-1 text-sm text-ink-muted">{t('exact.controls')}</legend>
          <Input name="gross" inputMode="decimal" placeholder={t('exact.gross')} />
          <Input name="td" inputMode="decimal" placeholder={t('exact.totalDeduction')} />
          <Input name="net" inputMode="decimal" placeholder={t('exact.net')} />
        </fieldset>
        <Button type="submit">{t('exact.upload')}</Button>
      </form>
      <Msg kind={message?.kind}>{message?.text}</Msg>
      {batchId && <Pipeline batchId={batchId} />}
    </Panel>
  );
}
