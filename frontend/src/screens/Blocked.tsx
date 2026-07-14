// E14 — Blocked (ESS-2/P7, Kira 2026-07-14): AUTH-04 · DISC-03 · LVR-01.
// A worker whose correct PIN lands on a suspended or terminated account is
// routed HERE — a clear, bilingual account-status screen, never a raw error
// and never a working session. Suspended (disciplinary, reversible) and
// terminated/closed (separation) are drawn DISTINCTLY per the Slice-14
// reference (ess-flow.js blockedScreen): lock/amber vs ban/red, each with its
// status chip. The status itself is server-decided at /auth/field — this
// screen renders the decision, it never infers one. Contact HR reveals the
// site-office guidance; no invented phone number or address is shown.
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IcBan, IcChevronL, IcLock, IcPhone } from '../components/icons';

export default function Blocked() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state } = useLocation() as { state?: { kind?: string } };
  const term = state?.kind === 'terminated';
  const [hint, setHint] = useState(false);

  return (
    <div className="ess" style={{ minHeight: '100vh' }} data-state={term ? 'terminated' : 'suspended'}>
      <div className="topbar">
        <div>
          <div className="tt">{t('ess.blocked.title')}</div>
          <div className="ts">{t('ess.blocked.sub')}</div>
        </div>
      </div>
      <div className="body">
        <div className="lock" style={{ minHeight: '70vh' }}>
          <span className={`ic ${term ? 'self' : 'hold'}`}>
            {term ? <IcBan style={{ width: 24, height: 24 }} /> : <IcLock style={{ width: 24, height: 24 }} />}
          </span>
          <h3>{term ? t('ess.blocked.termT') : t('ess.blocked.suspT')}</h3>
          <p>{term ? t('ess.blocked.termB') : t('ess.blocked.suspB')}</p>
          <div className="why">{term ? t('ess.blocked.termWhy') : t('ess.blocked.suspWhy')}</div>
          <button className="btn g" onClick={() => setHint(true)}>
            <IcPhone style={{ width: 14, height: 14 }} /> {t('ess.blocked.contactHr')}
          </button>
          {hint && <p style={{ maxWidth: 300 }}>{t('ess.blocked.contactHint')}</p>}
          <button className="btn g" onClick={() => navigate('/login', { replace: true })}>
            <IcChevronL style={{ width: 14, height: 14 }} /> {t('ess.blocked.back')}
          </button>
        </div>
      </div>
    </div>
  );
}
