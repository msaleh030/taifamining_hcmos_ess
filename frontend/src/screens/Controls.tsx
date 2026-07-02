// F7 — Controls & Checker (port of controls.js, AC-AUD-03; Design spec #2).
// TWO distinct grids, never conflated:
//   • all-clear — every control green, each showing its checked-count as audit
//     evidence ("N checked, 0 offenders"). data-state="all-clear".
//   • findings  — one or more controls failed; offending rows listed per
//     failing control. data-state="findings".
// The endpoint is guarded to the AUD/SOD set (registry controls.view.roles —
// drawn here, ratified at UAT); a role without access sees a distinct
// no-access panel, not a blank screen.
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { ControlsOut, ControlCheck } from '../lib/types';
import { NoAccess, ErrorPanel, Loading, Panel } from '../components/ui';

function CheckRow({ c }: { c: ControlCheck }) {
  const { t } = useTranslation();
  const name = t(`controls.check.${c.check}`, { defaultValue: c.check });
  if (c.pass) {
    return (
      <li data-check-state="ok" className="flex justify-between gap-3 py-2 border-b border-line">
        <span>{name}</span>
        <span className="text-ok">{t('controls.evidence', { checked: c.checked })}</span>
      </li>
    );
  }
  return (
    <li data-check-state="fail" className="py-2 border-b border-line">
      <div className="flex justify-between gap-3">
        <span>{name}</span>
        <span className="text-danger font-semibold">
          {t('controls.offenders', { checked: c.checked, offenders: c.offenders.length })}
        </span>
      </div>
      <ul className="list-disc pl-5 text-sm">
        {c.offenders.map((o, i) => <li key={i}>{JSON.stringify(o)}</li>)}
      </ul>
    </li>
  );
}

// Pure view. all_pass → the all-clear evidence grid; otherwise the findings grid.
export function ControlsView({ result }: { result: ControlsOut }) {
  const { t } = useTranslation();
  const state = result.all_pass ? 'all-clear' : 'findings';
  return (
    <Panel title={t('controls.title')} state={state}>
      <p className={result.all_pass ? 'text-ok font-semibold' : 'text-danger font-semibold'}>
        {result.all_pass ? t('controls.allClear') : t('controls.findings')}
      </p>
      <ul className="list-none p-0">
        {(result.checks ?? []).map((c) => <CheckRow key={c.check} c={c} />)}
      </ul>
    </Panel>
  );
}

export default function Controls() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['controls'], queryFn: api.controls, retry: false });
  if (q.isPending) return <Loading label={t('controls.running')} />;
  if (q.isError) {
    return isApiError(q.error) && q.error.status === 403
      ? <NoAccess title={t('controls.title')} message={t('controls.noAccess')} />
      : <ErrorPanel message={t('controls.error')} />;
  }
  return <ControlsView result={q.data} />;
}
