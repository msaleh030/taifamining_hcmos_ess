// App shell + routing. The nav is driven by /me/landing exactly as the
// certified scaffold's app.js: a user only ever sees the modules their role
// permits (A2), and the server enforces the same per endpoint — the nav is a
// convenience, never the gate. Screen routes mirror the scaffold's views 1:1.
import { Navigate, Route, Routes, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, session, isApiError } from './lib/api';
import { setLanguage } from './lib/i18n';
import Login from './screens/Login';
import Directory from './screens/Directory';
import Profile from './screens/Profile';
import Leave from './screens/Leave';
import Liability from './screens/Liability';
import { Scorecard, MyKpis } from './screens/Kpi';
import Attendance from './screens/Attendance';
import Exact from './screens/Exact';
import Alerts from './screens/Alerts';
import Support from './screens/Support';
import Policy from './screens/Policy';
import Controls from './screens/Controls';
import Tenant from './screens/Tenant';

// Fixed nav entries from the scaffold (each endpoint enforces its own guard;
// a role without access gets that screen's explained no-access state).
const VIEWS: [string, string][] = [
  ['/directory', 'directory'],
  ['/liability', 'liability'],
  ['/scorecard', 'scorecard'],
  ['/my-kpis', 'my kpis'],
  ['/attendance', 'clock in'],
  ['/exact', 'payroll upload'],
  ['/policy', 'policy'],
  ['/support', 'support'],
  ['/alerts', 'doc alerts'],
  ['/controls', 'controls'],
  ['/tenant', 'new tenant'],
];

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const landing = useQuery({ queryKey: ['landing'], queryFn: api.landing, retry: false });

  if (landing.isPending) return <p className="p-gutter text-ink-muted">Loading…</p>;
  if (landing.isError) {
    // Expired/invalid session → back to login (same convention as the scaffold).
    session.clear();
    const expired = isApiError(landing.error) && landing.error.status === 401;
    return <Navigate to="/login" state={{ message: expired ? t('login.expired') : t('login.dashError') }} replace />;
  }
  const l = landing.data;

  const signOut = () => {
    api.logout();
    queryClient.clear();
    navigate('/login');
  };

  return (
    <div>
      <div className="bg-uat text-brand-contrast text-center text-xs font-semibold tracking-wider uppercase py-1">
        {t('uat.banner')}
      </div>
      <header className="flex items-center gap-4 px-gutter py-3 bg-brand text-brand-contrast">
        <strong>{t('app.title')}</strong>
        <span className="ml-auto opacity-85 text-sm">{l.role} · {l.name}</span>
        <button
          className="text-sm underline"
          onClick={() => setLanguage(i18n.language === 'en' ? 'sw' : 'en')}
        >
          {i18n.language === 'en' ? 'SW' : 'EN'}
        </button>
        <button className="text-sm underline" onClick={signOut}>{t('app.signOut')}</button>
      </header>
      <nav className="px-gutter py-3">
        <ul className="list-none flex flex-wrap gap-2 m-0 p-0">
          {VIEWS.map(([to, label]) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `block px-3 py-1.5 bg-surface-raised border border-line rounded-control capitalize no-underline text-ink ${isActive ? 'border-brand font-semibold' : ''}`}
              >
                {label}
              </NavLink>
            </li>
          ))}
          {/* A2 landing modules (server-authoritative list). 'leave' opens the
              self-service leave screen, as in the scaffold. */}
          {l.modules.map((mod) => (
            <li key={mod}>
              {mod === 'leave' ? (
                <NavLink to="/leave" className="block px-3 py-1.5 bg-surface-raised border border-line rounded-control capitalize no-underline text-ink">{mod}</NavLink>
              ) : (
                <span className="block px-3 py-1.5 bg-surface border border-line rounded-control capitalize text-ink-muted">{mod}</span>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <main className="p-gutter">
        <Routes>
          <Route index element={<p className="text-ink-muted">{t('app.selectModule')}</p>} />
          <Route path="/directory" element={<Directory />} />
          <Route path="/directory/:id" element={<Profile />} />
          <Route path="/leave" element={<Leave />} />
          <Route path="/liability" element={<Liability />} />
          <Route path="/scorecard" element={<Scorecard />} />
          <Route path="/my-kpis" element={<MyKpis />} />
          <Route path="/attendance" element={<Attendance />} />
          <Route path="/exact" element={<Exact />} />
          <Route path="/policy" element={<Policy />} />
          <Route path="/support" element={<Support />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/controls" element={<Controls />} />
          <Route path="/tenant" element={<Tenant />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const location = useLocation();
  if (location.pathname === '/login') {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }
  if (!session.isAuthed) return <Navigate to="/login" replace />;
  return <Shell />;
}
