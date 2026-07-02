// Owned component primitives (shadcn-style: owned code, no runtime dependency).
// PLACEHOLDER SKINS: structure and semantics are final (they carry the
// data-state hooks the functional + visual ACs assert on); the styling is
// neutral token-driven until each redline lands from the Design Spec. Only
// this file and the per-screen views change for visual parity — behaviour
// hooks stay untouched.
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';

export function Panel({ title, state, children }: { title?: string; state?: string; children: ReactNode }) {
  return (
    <div data-state={state} className="bg-surface-raised border border-line rounded-card p-gutter">
      {title ? <h3 className="mt-0 mb-3 text-lg font-semibold">{title}</h3> : null}
      {children}
    </div>
  );
}

// Message with the backend's decision semantics: ok / blocked / info are
// DISTINCT — a block is never softened into a warning.
export function Msg({ kind, children }: { kind?: 'ok' | 'blocked' | 'info'; children: ReactNode }) {
  if (!children) return null;
  const tone = kind === 'ok' ? 'text-ok' : kind === 'blocked' ? 'text-danger font-semibold' : 'text-ink-muted';
  return <p role={kind === 'blocked' ? 'alert' : 'status'} className={`my-2 ${tone}`}>{children}</p>;
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-control border border-line bg-brand text-brand-contrast disabled:opacity-50 cursor-pointer ${props.className ?? ''}`}
    />
  );
}

export function GhostButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`px-3 py-2 rounded-control border border-line bg-surface-raised text-ink cursor-pointer ${props.className ?? ''}`}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`px-3 py-2 rounded-control border border-line bg-surface-raised ${props.className ?? ''}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`px-3 py-2 rounded-control border border-line bg-surface-raised ${props.className ?? ''}`} />;
}

// The universal no-access panel: an endpoint 403 is a distinct, explained
// state — never a blank screen, never a hidden nav item pretending the module
// does not exist when the server refused it.
export function NoAccess({ title, message }: { title: string; message: string }) {
  return (
    <Panel title={title} state="no-permission">
      <p className="text-ink-muted">{message}</p>
    </Panel>
  );
}

export function ErrorPanel({ message }: { message: string }) {
  return (
    <Panel state="error">
      <p className="text-danger">{message}</p>
    </Panel>
  );
}

export function Loading({ label }: { label?: string }) {
  return (
    <Panel state="loading">
      <p className="text-ink-muted">{label ?? 'Loading…'}</p>
    </Panel>
  );
}
