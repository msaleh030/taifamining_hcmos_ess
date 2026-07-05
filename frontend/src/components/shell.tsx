// K1 — console shell: 244px sidebar capped by the 3px tricolor rule (drawn by
// .side::before in the canonical sheet), grouped nav with ONE green active
// item, pinned system-status + user chip, 64px topbar with title/search/role
// banner. Nav visibility follows the server-authoritative A2 landing module
// list — the nav is a convenience, never the gate; every endpoint enforces
// its own guard and refused screens draw the designed no-permission state.
import { type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import type { Landing } from '../lib/types';
import { setLanguage } from '../lib/i18n';
import {
  IcGrid, IcUsers, IcChart, IcCalendar, IcMapPin, IcUpload, IcBanknote,
  IcShield, IcBell, IcFile, IcLifeBuoy, IcBuilding, IcSearch, IcLogOut, IcGlobe,
} from './icons';

interface NavEntry { to: string; label: string; icon: ReactNode; module?: string }
interface NavGroup { label: string; items: NavEntry[] }

// Groups per the spec's console track; `module` trims by the A2 landing list
// where the mapping is unambiguous — everything else stays visible and the
// SERVER decides (designed no-permission state on refusal).
const GROUPS: NavGroup[] = [
  {
    label: 'Workforce',
    items: [
      { to: '/', label: 'Overview', icon: <IcGrid />, module: 'dashboard' },
      { to: '/directory', label: 'Directory', icon: <IcUsers /> },
      { to: '/scorecard', label: 'KPI Scorecard', icon: <IcChart /> },
    ],
  },
  {
    label: 'Operations',
    items: [
      { to: '/leave', label: 'Leave', icon: <IcCalendar />, module: 'leave' },
      { to: '/attendance', label: 'Attendance', icon: <IcMapPin /> },
    ],
  },
  {
    label: 'Payroll',
    items: [
      { to: '/exact', label: 'Exact integration', icon: <IcUpload />, module: 'payroll' },
      { to: '/liability', label: 'Leave liability', icon: <IcBanknote />, module: 'payroll' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { to: '/controls', label: 'Controls & checker', icon: <IcShield /> },
      { to: '/alerts', label: 'Expiry alerts', icon: <IcBell /> },
      { to: '/policy', label: 'Policy', icon: <IcFile /> },
      { to: '/support', label: 'Support', icon: <IcLifeBuoy /> },
    ],
  },
  {
    label: 'Platform',
    items: [{ to: '/tenant', label: 'Tenant wizard', icon: <IcBuilding />, module: 'admin' }],
  },
];

export function initials(name: string): string {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

export default function Shell({ landing, title, subtitle, search, children }: {
  landing: Landing;
  title: string;
  subtitle?: string;
  search?: { placeholder: string; onChange: (q: string) => void };
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const modules = new Set(landing.modules);

  const signOut = () => {
    api.logout();
    queryClient.clear();
    navigate('/login');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* UAT instance label — test data, not production (remove for prod build) */}
      <div className="banner off" style={{ margin: 0, borderRadius: 0, justifyContent: 'center', padding: '4px 12px', fontSize: 11 }}>
        UAT · Test data · Not production · Carry policy pending
      </div>
      <div className="app" style={{ height: 'auto', flex: 1, minHeight: 0 }}>
        <aside className="side" style={{ height: 'auto' }}>
          <div className="brand">
            <div className="brand-sys" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
              <span className="bs-mark">HCMOS<sup>™</sup></span>
              <span className="bs-desc">Taifa Human Capital OS</span>
            </div>
          </div>
          <nav className="navlist">
            {GROUPS.map((g) => {
              const items = g.items.filter((it) => !it.module || modules.has(it.module));
              if (items.length === 0) return null;
              return (
                <div className="navsec" key={g.label}>
                  <div className="navgrp">{g.label}</div>
                  {items.map((it) => (
                    <NavLink key={it.to} to={it.to} end={it.to === '/'}
                      className={({ isActive }) => `navitem${isActive ? ' on' : ''}`}
                      style={{ textDecoration: 'none' }}>
                      {it.icon}
                      {it.label}
                    </NavLink>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="sideft">
            <div className="sys-stat"><span className="dot" />{t('overview.online')}</div>
            <div className="userchip">
              <div className="avatar">{initials(landing.name)}</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{landing.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--faint)' }}>{landing.role}</div>
              </div>
              <button className="iconbtn" style={{ width: 30, height: 30 }} onClick={signOut} title="Sign out"><IcLogOut /></button>
            </div>
          </div>
        </aside>
        <main className="main" style={{ height: 'auto' }}>
          <div className="topbar">
            <div className="tb-title">
              <div className="page-t">{title}</div>
              {subtitle ? <div className="page-s">{subtitle}</div> : null}
            </div>
            <div className="tb-tools">
              {search ? (
                <label className="search">
                  <IcSearch />
                  <input placeholder={search.placeholder} onChange={(e) => search.onChange(e.target.value)} />
                </label>
              ) : null}
              <div className="tb-div" />
              <span className="role-banner"><IcShield style={{ width: 14, height: 14 }} />{landing.role} · {landing.name}</span>
              <button className="iconbtn" onClick={() => setLanguage(i18n.language === 'en' ? 'sw' : 'en')}
                title={i18n.language === 'en' ? 'Kiswahili' : 'English'}>
                <IcGlobe />
              </button>
            </div>
          </div>
          <div className="content">{children}</div>
        </main>
      </div>
    </div>
  );
}
