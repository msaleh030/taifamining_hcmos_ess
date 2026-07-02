// F1 — employee profile (port of profile.js). Confidential fields render ONLY
// if present in the response: the server omits (A3) what a role may not see —
// ABSENT, NEVER MASKED; the UI never draws a redacted placeholder. Edits go
// through the maker-checker change flow; approval SoD is enforced server-side
// and a refusal is surfaced verbatim as the SoD message.
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, GhostButton, Input, Msg, Panel, Select, ErrorPanel, Loading } from '../components/ui';
import Disciplinary from './Disciplinary';

const EDITABLE = ['phone', 'email', 'dept', 'home_address', 'full_name'];

export default function Profile() {
  const { id = '' } = useParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [showDisciplinary, setShowDisciplinary] = useState(false);

  const emp = useQuery({ queryKey: ['employee', id], queryFn: () => api.employee(id), retry: false });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['employee', id] });

  const change = useMutation({
    mutationFn: (v: { field: string; value: string }) => api.requestChange(id, v.field, v.value),
    onSuccess: () => { setMessage(null); refresh(); },
    onError: (err) => setMessage(isApiError(err) && err.status === 403 ? t('profile.notPermitted') : t('profile.submitFailed')),
  });
  const approve = useMutation({
    mutationFn: (changeId: string) => api.approveChange(changeId),
    onSuccess: () => { setMessage(null); refresh(); },
    onError: (err) => setMessage(isApiError(err) && err.status === 403 ? t('profile.sodRefused') : t('profile.approveFailed')),
  });

  if (emp.isPending) return <Loading />;
  if (emp.isError) {
    return <ErrorPanel message={isApiError(emp.error) && emp.error.status === 404 ? t('profile.notFound') : t('profile.error')} />;
  }

  if (showDisciplinary) {
    return <Disciplinary employeeId={id} onDone={() => { setShowDisciplinary(false); refresh(); }} />;
  }

  // Render only the fields present (confidential ones are omitted upstream by A3).
  const fields = Object.entries(emp.data).filter(([k]) => k !== 'pending_changes');
  const pending = emp.data.pending_changes ?? [];

  return (
    <Panel state="ready">
      <table className="border-collapse">
        <tbody>
          {fields.map(([k, v]) => (
            <tr key={k} className="border-b border-line">
              <th className="text-left p-2 pr-4 align-top">{k}</th>
              <td className="p-2">{String(v ?? '')}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="mt-4 font-semibold">{t('profile.requestChange')}</h3>
      <form
        className="flex flex-wrap gap-2 mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          change.mutate({ field: String(f.get('field')), value: String(f.get('value') ?? '') });
        }}
      >
        <Select name="field">{EDITABLE.map((f) => <option key={f}>{f}</option>)}</Select>
        <Input name="value" placeholder={t('profile.newValue')} />
        <Button type="submit" disabled={change.isPending}>{t('profile.submitApproval')}</Button>
      </form>

      <h3 className="mt-4 font-semibold">{t('profile.pending')}</h3>
      <ul className="list-none p-0">
        {pending.length === 0 && <li className="text-ink-muted">{t('profile.none')}</li>}
        {pending.map((c) => (
          <li key={c.id} className="py-1">
            {c.field}: {c.before} → {c.after}{' '}
            <GhostButton onClick={() => approve.mutate(c.id)} disabled={approve.isPending}>{t('profile.approve')}</GhostButton>
          </li>
        ))}
      </ul>

      <GhostButton className="mt-3" onClick={() => setShowDisciplinary(true)}>{t('profile.disciplinary')}</GhostButton>
      <Msg kind="blocked">{message}</Msg>
    </Panel>
  );
}
