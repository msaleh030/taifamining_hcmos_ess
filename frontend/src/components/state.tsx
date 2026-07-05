// K8 — the five universal state primitives (AC-UNI-01), drawn with the
// promoted flow-kit classes (.skelrow/.center/.banner/.seal) so every screen
// shares one empty/loading/error/offline/success vocabulary. Screens add
// their own nets on top; every state carries data-state for the ACs.
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IcAlert, IcCheck, IcInfo, IcLock, IcWifiOff } from './icons';

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div data-state="loading" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 4 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skelrow" style={{ width: `${100 - (i % 3) * 18}%` }} />
      ))}
    </div>
  );
}

// Empty · .center — copy is per-screen (empty ≠ empty-match, C4).
export function EmptyState({ title, body, icon, children }: { title: string; body?: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="center" data-state="empty">
      <div className="ic">{icon ?? <IcInfo />}</div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {children}
    </div>
  );
}

// Error · .banner.err + retry — "nothing was changed" honesty comes from copy.
export function ErrorBanner({ text, onRetry, retryLabel }: { text: string; onRetry?: () => void; retryLabel?: string }) {
  const { t } = useTranslation();
  return (
    <div className="banner err" role="alert" data-state="error">
      <IcAlert />
      <div style={{ flex: 1 }}>{text}</div>
      {onRetry && <button className="btn sm" onClick={onRetry}>{retryLabel ?? t('governance.retry')}</button>}
    </div>
  );
}

// No-permission · .center.err — lock + WHY chip. The module/field is absent
// upstream (A3); this panel explains the refusal, it never masks data.
export function NoPermission({ title, body, why }: { title: string; body?: string; why?: string }) {
  return (
    <div className="center" data-state="no-permission">
      <div className="ic err"><IcLock /></div>
      <h3>{title}</h3>
      {body ? <p>{body}</p> : null}
      {why ? <span className="why">{why}</span> : null}
    </div>
  );
}

// Offline · .banner.off — queued work + last-synced honesty.
export function OfflineBanner({ text }: { text: string }) {
  return (
    <div className="banner off" data-state="offline">
      <IcWifiOff />
      <div>{text}</div>
    </div>
  );
}

// Success · .seal — hero confirmation (ok/err/off discs share the vocabulary).
export function Seal({ kind = 'ok', title, sub, big, children }: {
  kind?: 'ok' | 'err' | 'off'; title: string; sub?: string; big?: string; children?: ReactNode;
}) {
  const icon = kind === 'ok' ? <IcCheck /> : kind === 'err' ? <IcAlert /> : <IcWifiOff />;
  return (
    <div className="seal" data-state={kind === 'ok' ? 'success' : kind === 'err' ? 'error' : 'offline'}>
      <div className={`disc ${kind}`}>{icon}</div>
      <h3>{title}</h3>
      {big ? <div className="big num">{big}</div> : null}
      {sub ? <p>{sub}</p> : null}
      {children}
    </div>
  );
}

// Semantic status pill (K7): label + colour + non-colour signal (the dot).
export function Tag({ tone, children }: { tone: 'green' | 'blue' | 'yellow' | 'red' | 'grey'; children: ReactNode }) {
  return (
    <span className={`tag t-${tone}`}>
      <span className="dotbadge" style={{ background: 'currentColor' }} />
      {children}
    </span>
  );
}

// Monospace flag pill for [TBC]/[Open] registry decisions still in review (K7).
export function FlagPill({ children }: { children: ReactNode }) {
  return <span className="flag"><span className="dot" />{children}</span>;
}
