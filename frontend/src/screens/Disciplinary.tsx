// F2 — disciplinary action + fan-out (port of disciplinary.js, C8). One
// confirmed submission fans out server-side in a single transaction. SoD
// (subject ≠ self, issuer ≠ checker, permitted roles) is enforced at the
// endpoint; the screen reports the outcome or the refusal reason verbatim.
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Button, GhostButton, Input, Msg, Panel, Select } from '../components/ui';

const TYPES = ['verbal', 'written', 'final', 'suspension'];

export default function Disciplinary({ employeeId, onDone }: { employeeId: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const [message, setMessage] = useState<{ kind: 'ok' | 'blocked'; text: string } | null>(null);

  const issue = useMutation({
    mutationFn: (body: { actionType: string; detail: string; approverUserId: string }) =>
      api.issueDiscipline(employeeId, body),
    onSuccess: (out) => setMessage({
      kind: 'ok',
      text: t('disciplinary.issued', { type: out.action_type, manager: out.manager || 'n/a' })
        + (out.suspended ? t('disciplinary.suspended') : '.'),
    }),
    onError: (err) => setMessage({
      kind: 'blocked',
      text: isApiError(err) && err.status === 403
        ? t('disciplinary.refused', { reason: err.message }) // e.g. cannot act on self / issuer≠checker
        : t('disciplinary.failed'),
    }),
  });

  return (
    <Panel title={t('disciplinary.title')} state="ready">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          issue.mutate({
            actionType: String(f.get('type')),
            detail: String(f.get('detail') ?? ''),
            approverUserId: String(f.get('approver') ?? '').trim(),
          });
        }}
      >
        <Select name="type">{TYPES.map((x) => <option key={x}>{x}</option>)}</Select>
        <Input name="detail" placeholder={t('disciplinary.detail')} />
        <Input name="approver" placeholder={t('disciplinary.approver')} />
        <Button type="submit" disabled={issue.isPending}>{t('disciplinary.confirm')}</Button>
        {onDone && <GhostButton type="button" onClick={onDone}>{t('disciplinary.back')}</GhostButton>}
      </form>
      <Msg kind={message?.kind}>{message?.text}</Msg>
    </Panel>
  );
}
