// C1 — Login. Two tracks on one canvas (AUTH-01..04/06):
//   • CONSOLE (email + password + MFA — never a PIN): unchanged redline form.
//   • FIELD DEVICE (P1, AUTH-02): the ESS track for field workers — the
//     provisioned DEVICE ID is entered once at handover (by site HR) and
//     remembered on the handset; after that the worker only ever types their
//     PIN. Personal-device binding: one device, one person (the model
//     /auth/field supports — shared kiosks are a flagged, unbuilt scope).
// Errors reveal NO factor — one generic message on both tracks (AUTH-04).
// Pre-auth language toggle (EN/SW): the first surface 1,099 field workers see
// must be switchable BEFORE any sign-in — P1 ships bilingual.
import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, isApiError } from '../lib/api';
import { setLanguage } from '../lib/i18n';
import { OfflineBanner } from '../components/state';
import { IcAlert, IcLifeBuoy, IcLock, IcUser } from '../components/icons';

const DEVICE_KEY = 'hcmos.device_id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function Login() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { message?: string } };
  const [mode, setMode] = useState<'console' | 'field'>(
    () => (localStorage.getItem(DEVICE_KEY) ? 'field' : 'console'));
  const [message, setMessage] = useState<string | null>(location.state?.message ?? null);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(!navigator.onLine);
  // MFA field visibility follows the server's auth.mfa.required (ONE toggle:
  // hidden here === not enforced there). Default true = shown until told
  // otherwise, so a fetch failure never hides a required factor.
  const [mfaField, setMfaField] = useState(true);
  // Field device identity: provisioned id, entered once, kept on the handset.
  const [deviceId, setDeviceId] = useState<string | null>(() => localStorage.getItem(DEVICE_KEY));

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

  async function submitConsole(e: FormEvent<HTMLFormElement>) {
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

  async function submitField(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    // Device id: the remembered one, or the one being enrolled right now.
    const dev = (deviceId ?? String(f.get('device_id') ?? '').trim()).toLowerCase();
    if (!UUID_RE.test(dev)) { setMessage(t('auth.fieldDeviceInvalid')); return; }
    setBusy(true);
    try {
      await api.fieldLogin(dev, String(f.get('pin') ?? '').trim());
      // Only a SUCCESSFUL sign-in enrols the handset — a typo never sticks.
      localStorage.setItem(DEVICE_KEY, dev);
      setDeviceId(dev);
      navigate('/ess');
    } catch (err) {
      // E14: a correct PIN on a suspended/terminated account gets the DISTINCT
      // blocked screen (the server discloses status only after the PIN proves
      // identity) — never a raw error, never a working session.
      const blocked = isApiError(err) && err.status === 403
        && (err.body as { blocked?: string } | null)?.blocked;
      if (blocked === 'suspended' || blocked === 'terminated') {
        navigate('/blocked', { state: { kind: blocked }, replace: true });
        return;
      }
      // Generic — never which factor failed (AUTH-04); a locked device reads the same.
      setMessage(isApiError(err) && err.status === 401 ? t('auth.errField') : (err instanceof Error && err.message) || t('auth.errField'));
    } finally {
      setBusy(false);
    }
  }

  const langToggle = (
    <button type="button" className="pill" style={{ marginLeft: 'auto' }}
      aria-label={t('auth.langToggle')}
      onClick={() => setLanguage(i18n.language === 'en' ? 'sw' : 'en')}>
      {i18n.language === 'en' ? 'SW · Kiswahili' : 'EN · English'}
    </button>
  );

  return (
    <div className="login" data-state={busy ? 'loading' : message ? 'error' : 'populated'} data-mode={mode}>
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
        {mode === 'console' ? (
          <form className="lf-inner" onSubmit={submitConsole}>
            <div className="lf-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div>
                <div className="lf-t">{t('auth.consoleTitle')}</div>
                <div className="lf-s">{t('auth.consoleSub')}</div>
              </div>
              {langToggle}
            </div>
            <ModeTabs mode={mode} onMode={(m) => { setMode(m); setMessage(null); }} />
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
        ) : (
          <form className="lf-inner" onSubmit={submitField}>
            <div className="lf-head" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <div>
                <div className="lf-t">{t('auth.fieldTitle')}</div>
                <div className="lf-s">{t('auth.fieldSub')}</div>
              </div>
              {langToggle}
            </div>
            <ModeTabs mode={mode} onMode={(m) => { setMode(m); setMessage(null); }} />
            {offline && <OfflineBanner text={t('auth.offField')} />}
            {message && !offline && (
              <div className="banner err" role="alert"><IcAlert />{message}</div>
            )}
            {deviceId ? (
              // Enrolled handset: the worker only ever sees the PIN pad.
              <div className="lf-field">
                <span>{t('auth.fieldDevice')}</span>
                <div className="lf-input" style={{ justifyContent: 'space-between' }}>
                  <span className="num" style={{ fontSize: 12 }}>…{deviceId.slice(-8)}</span>
                  <button type="button" className="btn sm ghost"
                    onClick={() => { localStorage.removeItem(DEVICE_KEY); setDeviceId(null); }}>
                    {t('auth.fieldDeviceChange')}
                  </button>
                </div>
              </div>
            ) : (
              // One-time enrolment (site HR enters the provisioned device id at handover).
              <label className="lf-field">
                <span>{t('auth.fieldDeviceEnrol')}</span>
                <span className="lf-input"><IcShieldDots />
                  <input name="device_id" autoComplete="off" spellCheck={false}
                    placeholder="00000000-0000-0000-0000-000000000000" required /></span>
                <span className="lf-s" style={{ marginTop: 4 }}>{t('auth.fieldDeviceEnrolNote')}</span>
              </label>
            )}
            <label className="lf-field">
              <span>{t('auth.pin')}</span>
              <span className="lf-input"><IcLock style={{ width: 15, height: 15 }} />
                <input name="pin" type="password" inputMode="numeric" pattern="[0-9]*"
                  autoComplete="off" maxLength={8} required /></span>
            </label>
            <button className="btn primary lf-go" type="submit" disabled={busy || offline}>
              {busy ? t('auth.signing') : t('auth.fieldSignin')}
            </button>
            <div className="lf-help"><IcLifeBuoy style={{ width: 14, height: 14 }} />{t('auth.fieldHelp')}</div>
          </form>
        )}
      </div>
    </div>
  );
}

// The console/field track switch — a segmented pill row, present pre-auth on
// both tracks so a field worker handed a console link (or vice versa) can
// self-correct without help-desk traffic.
function ModeTabs({ mode, onMode }: { mode: 'console' | 'field'; onMode: (m: 'console' | 'field') => void }) {
  const { t } = useTranslation();
  return (
    <div className="sitefilter" role="tablist" style={{ margin: '2px 0 6px' }}>
      <button type="button" role="tab" aria-selected={mode === 'console'}
        className={`pill${mode === 'console' ? ' on' : ''}`} onClick={() => onMode('console')}>
        {t('auth.tabConsole')}
      </button>
      <button type="button" role="tab" aria-selected={mode === 'field'}
        className={`pill${mode === 'field' ? ' on' : ''}`} onClick={() => onMode('field')}>
        {t('auth.tabField')}
      </button>
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
