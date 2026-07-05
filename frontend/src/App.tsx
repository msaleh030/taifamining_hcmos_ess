// Routing + theme/surface plumbing. [data-theme] and [data-surface] ride the
// <html> root (F6); the surface is derived from the viewport (mobile ≤480,
// tablet ≤820, desktop above; kiosk via ?surface=kiosk) so every screen
// renders across the 4×4 matrix without per-screen code. The A2 landing is
// server-authoritative: R13 (field) has no console landing and routes to the
// ESS track (C2 rule); everyone else gets the console shell.
import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, session, isApiError } from './lib/api';
import Login from './screens/Login';
import Overview from './screens/Overview';
import Directory from './screens/Directory';
import { Scorecard, MyKpis } from './screens/Kpi';
import Leave from './screens/Leave';
import Liability from './screens/Liability';
import Exact from './screens/Exact';
import Alerts from './screens/Alerts';
import Controls from './screens/Controls';
import Policy from './screens/Policy';
import Support from './screens/Support';
import Tenant from './screens/Tenant';
import Attendance from './screens/Attendance';
import EssHome from './screens/EssHome';
import Shell from './components/shell';
import { Skeleton } from './components/state';

function applySurface() {
  const forced = new URLSearchParams(location.search).get('surface');
  const w = window.innerWidth;
  const surface = forced ?? (w <= 480 ? 'mobile' : w <= 820 ? 'tablet' : 'desktop');
  document.documentElement.setAttribute('data-surface', surface);
}

function useThemeSurface() {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', localStorage.getItem('hcmos.theme') || 'light');
    applySurface();
    window.addEventListener('resize', applySurface);
    return () => window.removeEventListener('resize', applySurface);
  }, []);
}

function Console() {
  const { t } = useTranslation();
  const location = useLocation();
  const landing = useQuery({ queryKey: ['landing'], queryFn: api.landing, retry: false });

  if (landing.isPending) return <div style={{ padding: 28 }}><Skeleton rows={6} /></div>;
  if (landing.isError) {
    session.clear();
    const expired = isApiError(landing.error) && landing.error.status === 401;
    return <Navigate to="/login" state={{ message: expired ? t('auth.errCreds') : t('overview.errT') }} replace />;
  }
  const l = landing.data;

  // R13 field operators have no console landing — the ESS track is home.
  if (l.role === 'R13' && !location.pathname.startsWith('/ess')) return <Navigate to="/ess" replace />;

  // Per-route page titles (the topbar redline: title + subtitle).
  const TITLES: Record<string, [string, string?]> = {
    '/': [t('overview.title'), t('overview.org')],
    '/directory': [t('employees.directory'), t('employees.directorySub')],
    '/scorecard': [t('kpi.console'), t('kpi.consoleSub')],
    '/leave': [t('leave.apply'), t('leave.applySub')],
    '/liability': [t('leave.liability'), t('leave.liabilitySub')],
    '/exact': [t('exact.exact'), t('exact.exactSub')],
    '/alerts': [t('governance.alerts'), t('governance.alertsSub')],
    '/controls': [t('governance.controls'), t('governance.controlsSub')],
    '/policy': [t('governance.policy'), t('governance.policySub')],
    '/support': [t('governance.support'), t('governance.supportSub')],
    '/tenant': [t('tenant.wizard'), t('tenant.wizardSub')],
    '/attendance': [t('attendance.clockin'), t('attendance.clockinSub')],
    '/my-kpis': [t('kpi.ess'), t('kpi.essSub')],
  };
  const base = '/' + (location.pathname.split('/')[1] || '');
  const [title, subtitle] = TITLES[base] ?? TITLES['/'];

  return (
    <Shell landing={l} title={title} subtitle={subtitle}>
      <Routes>
        <Route index element={<Overview landing={l} />} />
        <Route path="/directory" element={<Directory />} />
        <Route path="/directory/:id" element={<Directory />} />
        <Route path="/scorecard" element={<Scorecard />} />
        <Route path="/my-kpis" element={<MyKpis />} />
        <Route path="/leave" element={<Leave />} />
        <Route path="/liability" element={<Liability />} />
        <Route path="/exact" element={<Exact />} />
        <Route path="/alerts" element={<Alerts />} />
        <Route path="/controls" element={<Controls />} />
        <Route path="/policy" element={<Policy />} />
        <Route path="/support" element={<Support />} />
        <Route path="/tenant" element={<Tenant />} />
        <Route path="/attendance" element={<Attendance />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  useThemeSurface();
  const location = useLocation();
  if (location.pathname === '/login') {
    return <Routes><Route path="/login" element={<Login />} /></Routes>;
  }
  if (!session.isAuthed) return <Navigate to="/login" replace />;
  if (location.pathname.startsWith('/ess')) {
    return (
      <Routes>
        <Route path="/ess" element={<EssHome />} />
        <Route path="/ess/clockin" element={<div className="ess"><Attendance ess /></div>} />
        <Route path="/ess/leave" element={<div className="ess"><Leave ess /></div>} />
        <Route path="/ess/kpis" element={<div className="ess"><MyKpis ess /></div>} />
        <Route path="*" element={<Navigate to="/ess" replace />} />
      </Routes>
    );
  }
  return <Console />;
}
