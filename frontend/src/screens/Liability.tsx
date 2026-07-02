// F3 — leave liability (port of liability.js; pay-adjacent, confidential).
// Reachable only by the pay-visibility roles; a 403 renders the explained
// no-access state. Figures come from the ONE name-keyed base ÷ 30, active
// staff only; an employee with no captured remuneration shows a NOT-AVAILABLE
// row naming the missing input — never a zero.
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, Input, NoAccess, ErrorPanel, Loading, Panel } from '../components/ui';

export default function Liability() {
  const { t } = useTranslation();
  const [batchId, setBatchId] = useState('');

  const res = useQuery({
    queryKey: ['liability', batchId],
    queryFn: () => api.liabilityBatch(batchId),
    enabled: !!batchId,
    retry: false,
  });

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBatchId(String(new FormData(e.currentTarget).get('batch') ?? '').trim());
  }

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2 mb-3">
        <Input name="batch" placeholder="Exact batch id" required />
        <Button type="submit">{t('liability.title')}</Button>
      </form>

      {!batchId ? null : res.isPending ? <Loading /> : res.isError ? (
        isApiError(res.error) && res.error.status === 403
          ? <NoAccess title={t('liability.title')} message={t('liability.restricted')} />
          : <ErrorPanel message={t('liability.error')} />
      ) : (
        <Panel title={t('liability.title')} state="ready">
          <p>{t('liability.total')}: <strong>{res.data.total}</strong> ({t('liability.activeOnly')})</p>
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left border-b border-line">
                <th className="p-2">{t('liability.employee')}</th>
                <th className="p-2">{t('liability.days')}</th>
                <th className="p-2">{t('liability.dailyRate')}</th>
                <th className="p-2">{t('liability.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {res.data.available.length === 0 && (
                <tr><td className="p-2" colSpan={4}>{t('liability.noLiability')}</td></tr>
              )}
              {res.data.available.map((a) => (
                <tr key={a.employee_id} className="border-b border-line">
                  <td className="p-2">{a.employee_id}</td>
                  <td className="p-2">{a.days}</td>
                  <td className="p-2">{a.daily_rate}</td>
                  <td className="p-2">{a.liability}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4 className="mt-3 font-semibold">{t('liability.notAvailable')}</h4>
          <ul className="list-disc pl-5">
            {(res.data.not_available ?? []).length === 0 && <li className="text-ink-muted">{t('profile.none')}</li>}
            {(res.data.not_available ?? []).map((n) => (
              <li key={n.employee_id}>{n.employee_id}: <em>{t('leave.notAvailable')}</em> — {n.missing}</li>
            ))}
          </ul>
          <h4 className="mt-3 font-semibold">{t('liability.excluded')}</h4>
          <ul className="list-disc pl-5">
            {(res.data.excluded ?? []).length === 0 && <li className="text-ink-muted">{t('profile.none')}</li>}
            {(res.data.excluded ?? []).map((x) => <li key={x.employee_id}>{x.employee_id} ({x.status})</li>)}
          </ul>
        </Panel>
      )}
    </div>
  );
}
