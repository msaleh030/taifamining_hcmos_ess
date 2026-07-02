// F3 — leave (port of leave.js, self-service). Annual balance + the SEPARATE
// sick bucket; a sick limit that is not configured shows as NOT AVAILABLE
// naming the missing input — never a guessed number. LR-5 (max continuous +
// HoH override) and the available balance are enforced server-side; a refusal
// message is surfaced verbatim.
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { Button, Input, Msg, Panel, Select, ErrorPanel, Loading } from '../components/ui';

export default function Leave() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);

  const bal = useQuery({ queryKey: ['leave-balance'], queryFn: api.leaveBalance, retry: false });
  const apply = useMutation({
    mutationFn: (body: { leave_type: string; days: number; hoh_override: boolean }) => api.leaveApply(body),
    onSuccess: () => { setMessage(null); queryClient.invalidateQueries({ queryKey: ['leave-balance'] }); },
    onError: (err: Error) => setMessage(err.message || t('leave.applyError')),
  });

  if (bal.isPending) return <Loading />;
  if (bal.isError) return <ErrorPanel message={t('leave.error')} />;
  const b = bal.data;

  const sickLimit = typeof b.sick.available === 'object' && b.sick.available.available === false
    ? { na: true as const, missing: b.sick.available.missing }
    : { na: false as const };

  return (
    <Panel title={t('leave.title')} state="ready">
      <ul className="list-disc pl-5">
        <li>
          {t('leave.annual')}: {t('leave.available')} <strong>{b.annual.available}</strong>{' '}
          ({t('leave.entitlement')} {b.annual.entitlement} + {t('leave.carried')} {b.annual.carried} − {t('leave.taken')} {b.annual.taken})
        </li>
        <li>
          {t('leave.sick')}: {t('leave.taken')} {b.sick.taken}
          {sickLimit.na && <> · {t('leave.limit')} <em>{t('leave.notAvailable')}</em> ({sickLimit.missing})</>}
        </li>
      </ul>

      <h3 className="mt-4 font-semibold">{t('leave.apply')}</h3>
      <form
        className="flex flex-wrap gap-2 mt-2 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          apply.mutate({
            leave_type: String(f.get('type')),
            days: Number(f.get('days')),
            hoh_override: f.get('hoh') === 'on',
          });
        }}
      >
        <Select name="type">
          <option value="annual">annual</option>
          <option value="sick">sick</option>
        </Select>
        <Input name="days" type="number" min={0.5} step={0.5} placeholder={t('leave.days')} />
        <label className="flex items-center gap-1"><input type="checkbox" name="hoh" /> {t('leave.hoh')}</label>
        <Button type="submit" disabled={apply.isPending}>{t('leave.submit')}</Button>
      </form>
      <Msg kind="blocked">{message}</Msg>
    </Panel>
  );
}
