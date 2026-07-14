// C8 — Disciplinary action + fan-out (DISC-01..04, SOD-01/02, UNI-06). One
// confirmed submission fans out server-side in a single transaction; the
// fan-out panel lists WHO gets notified. SoD is visible: the checker is
// named and must differ from the issuer; issuer ≠ subject (acting on
// yourself is refused — the distinct self state). Refusals are surfaced
// verbatim; on error nothing was recorded. Confidential to the permitted
// role set (A3) — the endpoint decides.
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { Seal } from '../components/state';
import { IcAlert, IcBell, IcCheck, IcFile, IcUsers } from '../components/icons';

const TYPES = ['verbal', 'written', 'final', 'suspension'];

export default function Disciplinary({ employeeId, onDone }: { employeeId: string; onDone?: () => void }) {
  const { t } = useTranslation();
  const [refusal, setRefusal] = useState<{ self?: boolean; text: string } | null>(null);

  const issue = useMutation({
    mutationFn: (body: { actionType: string; detail: string; approverUserId: string }) =>
      api.issueDiscipline(employeeId, body),
    onError: (err) => {
      if (isApiError(err) && err.status === 403) {
        const self = /self/i.test(err.message);
        setRefusal({ self, text: err.message });
      } else {
        setRefusal({ text: t('disciplinary.errBody') });
      }
    },
    onSuccess: () => setRefusal(null),
  });

  if (issue.isSuccess) {
    const out = issue.data;
    return (
      <div className="card card-p" data-state="success">
        <Seal title={out.suspended ? t('disciplinary.fanSuspTitle') : t('disciplinary.fanWarnTitle')}
              sub={out.suspended ? t('disciplinary.fanSuspSub') : t('disciplinary.fanWarnSub')} />
        <span className="tag t-blue" style={{ margin: '8px 0' }}>{t('disciplinary.atomTag')}</span>
        <div className="fan">
          <div className="fanhead">{t('disciplinary.fanWarnTitle')}</div>
          {[['fRegister', 'fRegisterD', <IcFile key="i" />],
            ['fEss', 'fEssD', <IcUsers key="i" />],
            ['fConsole', 'fConsoleD', <IcBell key="i" />],
            ['fLetter', 'fLetterD', <IcFile key="i" />],
            ['fAudit', 'fAuditD', <IcCheck key="i" />],
            ...(out.suspended ? [['fStatus', 'fStatusD', <IcAlert key="i" />] as const] : [])]
            .map(([k, d, icon]) => (
              <div className="fanitem" key={String(k)}>
                {icon}
                <span><b>{t(`disciplinary.${k}`)}</b><br /><span className="muted" style={{ fontSize: 11 }}>{t(`disciplinary.${d}`)}</span></span>
                <IcCheck style={{ marginLeft: 'auto', color: 'var(--green)', width: 15, height: 15 }} />
              </div>
            ))}
        </div>
        {out.manager && <p className="note">{t('disciplinary.byline')}: <span className="num">{out.manager}</span></p>}
        {onDone && <button className="btn" style={{ marginTop: 8 }} onClick={onDone}>{t('disciplinary.cancel')}</button>}
      </div>
    );
  }

  return (
    <form className="card card-p" data-state={refusal ? (refusal.self ? 'self' : 'error') : 'drafted'}
      onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        issue.mutate({
          actionType: String(f.get('type')),
          detail: String(f.get('detail') ?? ''),
          approverUserId: String(f.get('approver') ?? '').trim(),
        });
      }}>
      <div className="shead">{t('disciplinary.atype')}</div>
      <div className="fg" style={{ marginTop: 10 }}>
        <div className="field">
          <label>{t('disciplinary.atype')} <span className="req">*</span></label>
          <select name="type">{TYPES.map((x) => <option key={x}>{x}</option>)}</select>
        </div>
        <div className="field">
          <label>{t('disciplinary.ground')}</label>
          <input name="detail" placeholder={t('disciplinary.detailsPH')} />
        </div>
        <div className="field full">
          <label>{t('disciplinary.rChecker')} <span className="req">*</span></label>
          <input name="approver" placeholder={t('disciplinary.approver')} required />
        </div>
      </div>

      {/* SoD visibility — issuer ≠ subject ≠ checker, enforced server-side */}
      <div className="note" style={{ marginTop: 8 }}>
        <IcAlert style={{ width: 13, height: 13 }} />{t('disciplinary.sodMatrix')}
      </div>

      {refusal && (
        <div className="banner err" role="alert" style={{ marginTop: 10 }}>
          <IcAlert />
          <div>
            <b>{refusal.self ? t('disciplinary.selfTitle') : t('disciplinary.forbid')}</b>{' '}
            {refusal.self ? t('disciplinary.selfBody') : refusal.text}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn primary" type="submit" disabled={issue.isPending}>
          {issue.isPending ? t('disciplinary.saving') : t('disciplinary.issueWarn')}
        </button>
        {onDone && <button className="btn ghost" type="button" onClick={onDone}>{t('disciplinary.cancel')}</button>}
      </div>
    </form>
  );
}
