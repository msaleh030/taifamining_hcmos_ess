// C1 — Login, console MFA (AUTH-01/03/04/06). Split canvas per the redline:
// two-panel .login grid (1.05fr/1fr), dark brand panel with the tricolor flag
// + radial wash (canonical .login-brand), centred form (.lf-inner max 380).
// The error reveals NO factor — one generic message, never which of
// user/password/MFA failed. Offline: console sign-in needs a connection.
// The h1 is the spec's F2 display sample; per-role landing (least-privilege
// A2) is the server's routing decision after success.
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { OfflineBanner } from '../components/state';
import { IcAlert, IcLifeBuoy, IcLock, IcUser } from '../components/icons';

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { message?: string } };
  const [message, setMessage] = useState<string | null>(location.state?.message ?? null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  // MFA field visibility follows the server's auth.mfa.required (ONE toggle:
  // hidden here === not enforced there). Default true = shown until told
  // otherwise, so a fetch failure never hides a required factor.
  const [mfaField, setMfaField] = useState(true);

  useEffect(() => {
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    let live = true;
    api.authConfig().then((c) => { if (live) setMfaField(c.mfaRequired); }).catch(() => { /* keep shown on error */ });
    return () => { live = false; };
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    try {
      await api.login(String(f.get('email') ?? '').trim(), String(f.get('password') ?? ''), String(f.get('mfa') ?? '').trim());
      navigate('/'); // routed to the role landing (least-privilege per A2)
    } catch (err) {
      // Generic — never which factor failed (AUTH-04).
      setMessage(isApiError(err) && err.status === 401 ? t('auth.errCreds') : (err instanceof Error && err.message) || t('auth.errCreds'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login" data-state={busy ? 'loading' : message ? 'error' : 'populated'}>
      <div className="login-brand">
        <div className="lb-top">
          <span className="bs-mark" style={{ fontSize: 15, letterSpacing: '.06em' }}>HCMOS<sup>™</sup></span>
        </div>
        <div className="lb-mid">
          <div className="lb-flag">
            <span style={{ background: '#1FA24A' }} />
            <span style={{ background: '#FBC02D' }} />
            <span style={{ background: '#0094D4' }} />
          </div>
          <div className="lb-eyebrow">TAIFA MINING &amp; CIVIL</div>
          <h1>Human capital, operational</h1>
          <p>Taifa Human Capital Operating System — the governed system of record for people, leave, attendance and pay visibility.</p>
        </div>
        <div className="lb-foot">{t('auth.help')}</div>
      </div>
      <div className="login-form">
        <form className="lf-inner" onSubmit={submit}>
          <div className="lf-head">
            <div className="lf-t">{t('auth.consoleTitle')}</div>
            <div className="lf-s">{t('auth.consoleSub')}</div>
          </div>
          {offline && <OfflineBanner text={t('auth.offConsole')} />}
          {message && !offline && (
            <div className="banner err" role="alert"><IcAlert />{message}</div>
          )}
          <label className="lf-field">
            <span>{t('auth.email')}</span>
            <span className="lf-input"><IcUser style={{ width: 15, height: 15 }} />
              <input name="email" type="email" autoComplete="username" required /></span>
          </label>
          <label className="lf-field">
            <span>{t('auth.pass')}</span>
            <span className="lf-input"><IcLock style={{ width: 15, height: 15 }} />
              <input name="password" type="password" autoComplete="current-password" required /></span>
          </label>
          {/* MFA field: shown + enforced when auth.mfa.required is on (AUTH-01
              default). Hidden together with enforcement during the reversible
              setup phase — driven by the SAME flag via GET /auth/config. */}
          {mfaField && (
            <label className="lf-field">
              <span>{t('auth.mfa')}</span>
              <span className="lf-input"><IcShieldDots />
                <input name="mfa" inputMode="numeric" pattern="[0-9]*" maxLength={6} /></span>
            </label>
          )}
          <button className="btn primary lf-go" type="submit" disabled={busy || offline}>
            {busy ? t('auth.signing') : t('auth.signin')}
          </button>
          <div className="lf-help"><IcLifeBuoy style={{ width: 14, height: 14 }} />{t('auth.help')}</div>
        </form>
      </div>
    </div>
  );
}

function IcShieldDots() {
  return (
    <svg className="svg" style={{ width: 15, height: 15 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <circle cx="9" cy="11" r=".6" fill="currentColor" /><circle cx="12" cy="11" r=".6" fill="currentColor" /><circle cx="15" cy="11" r=".6" fill="currentColor" />
    </svg>
  );
}
