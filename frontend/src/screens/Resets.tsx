// P5 — credential resets (console): password (AUTH) + field PIN (AUTH-05).
// THE GATES LIVE SERVER-SIDE and this screen renders their verdicts:
//   • owner-gated: only password.reset.owner / pin.reset.owner roles may look
//     up targets or reset (403 → the designed no-permission state);
//   • RANK LATTICE: a reset may only TARGET a role at or below the actor's
//     rank (bughunt-B #3) — a refused escalation renders the server's reason;
//   • every reset revokes the target's sessions and is AUDITED (auth_reset_*
//     append to the chain); the count of revoked sessions is shown back.
// Lookup is server-side (owner-gated, minimal fields, capped) — the reset
// screen is not a directory.
import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import type { ResetLookupOut } from '../lib/types';
import { NoPermission, Seal } from '../components/state';
import { IcAlert, IcCheck, IcLock, IcSearch, IcShield, IcUser } from '../components/icons';

type Target =
  | { kind: 'user'; id: string; label: string; sub: string }
  | { kind: 'device'; id: string; label: string; sub: string };

export default function Resets() {
  const { t } = useTranslation();
  const [results, setResults] = useState<ResetLookupOut | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; kind?: 'user' | 'device'; revoked?: number; reason?: string } | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const lookup = useMutation({
    mutationFn: (q: string) => api.resetLookup(q),
    onSuccess: (r) => { setResults(r); setTarget(null); setOutcome(null); },
    onError: (err: Error) => { if (isApiError(err) && err.status === 403) setForbidden(true); },
  });

  const reset = useMutation({
    mutationFn: (v: { target: Target; secret: string }) =>
      v.target.kind === 'user'
        ? api.resetPassword({ target_user: v.target.id, new_password: v.secret })
        : api.resetPin({ device_id: v.target.id, new_pin: v.secret }),
    onSuccess: (r, v) => setOutcome({ ok: true, kind: v.target.kind, revoked: r.revoked_sessions }),
    onError: (err: Error) => {
      if (isApiError(err) && err.status === 403) {
        setOutcome({ ok: false, reason: (err.body as { error?: string })?.error ?? t('resets.forbidden') });
      } else {
        setOutcome({ ok: false, reason: t('resets.failed') });
      }
    },
  });

  if (forbidden) {
    return <NoPermission title={t('resets.title')} body={t('resets.forbidden')} why="P5 · password.reset.owner / pin.reset.owner" />;
  }

  return (
    <div className="grid" style={{ maxWidth: 640 }} data-state={outcome && !outcome.ok ? 'error' : 'populated'}>
      {/* find the target — server-side, owner-gated */}
      <form className="card card-p" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const q = String(new FormData(e.currentTarget).get('q') || '');
        if (q.trim().length >= 2) lookup.mutate(q.trim());
      }}>
        <div className="fg">
          <div className="field" style={{ flex: 1 }}>
            <label>{t('resets.searchPH')}</label>
            <input name="q" placeholder={t('resets.searchPH')} autoComplete="off" />
          </div>
          <button className="btn" type="submit" disabled={lookup.isPending}>
            <IcSearch style={{ width: 14, height: 14 }} /> {t('resets.search')}
          </button>
        </div>
        <p className="note" style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center' }}>
          <IcShield style={{ width: 13, height: 13 }} />{t('resets.latticeNote')}
        </p>
      </form>

      {results && !target && (
        <div className="card card-p">
          {results.users.length === 0 && results.devices.length === 0 && (
            <p className="note">{t('resets.noneFound')}</p>
          )}
          {results.users.map((u) => (
            <button key={u.id} type="button" className="qitem" style={{ width: '100%', textAlign: 'left', marginTop: 6 }}
              onClick={() => setTarget({ kind: 'user', id: u.id, label: u.email, sub: `${t('resets.pickUser')} · ${u.role_code}` })}>
              <span className="qi"><IcUser /></span>
              <span><span className="qt">{u.email}</span><br /><span className="qd">{t('resets.pickUser')} · {u.role_code}</span></span>
            </button>
          ))}
          {results.devices.map((d) => (
            <button key={d.id} type="button" className="qitem" style={{ width: '100%', textAlign: 'left', marginTop: 6 }}
              onClick={() => setTarget({ kind: 'device', id: d.id, label: d.full_name, sub: `${t('resets.pickDevice')} · ${d.emp_no ?? '—'}` })}>
              <span className="qi"><IcLock /></span>
              <span><span className="qt">{d.full_name}</span><br /><span className="qd">{t('resets.pickDevice')} · {d.emp_no ?? '—'}</span></span>
            </button>
          ))}
        </div>
      )}

      {target && !outcome?.ok && (
        <form className="card card-p" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const secret = String(new FormData(e.currentTarget).get('secret') || '');
          if (secret) reset.mutate({ target, secret });
        }}>
          <div className="qitem">
            <span className="qi">{target.kind === 'user' ? <IcUser /> : <IcLock />}</span>
            <span><span className="qt">{target.label}</span><br /><span className="qd">{target.sub}</span></span>
          </div>
          <div className="fg" style={{ marginTop: 10 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>{target.kind === 'user' ? t('resets.newPw') : t('resets.newPin')} <span className="req">*</span></label>
              <input name="secret" type={target.kind === 'user' ? 'password' : 'text'} required
                inputMode={target.kind === 'device' ? 'numeric' : undefined} autoComplete="new-password" />
            </div>
          </div>
          {outcome && !outcome.ok && (
            <div className="banner err" style={{ marginTop: 10 }} role="alert">
              <IcAlert /><div>{outcome.reason}</div>
            </div>
          )}
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn primary" type="submit" disabled={reset.isPending}>
              <IcCheck style={{ width: 14, height: 14 }} /> {target.kind === 'user' ? t('auth.resetPw') : t('auth.resetPin')}
            </button>
            <button className="btn" type="button" onClick={() => { setTarget(null); setOutcome(null); }}>{t('leave.close')}</button>
          </div>
        </form>
      )}

      {outcome?.ok && (
        <div className="card card-p" data-state="success">
          <Seal title={outcome.kind === 'user' ? t('resets.okPw') : t('resets.okPin')}
            sub={`${outcome.revoked ?? 0} ${t('resets.revoked')}`} />
          <p className="note" style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
            <IcShield style={{ width: 13, height: 13 }} />{t('attendance.auditExt')}
          </p>
        </div>
      )}
    </div>
  );
}
