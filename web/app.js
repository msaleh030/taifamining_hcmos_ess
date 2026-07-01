// F0 — app bootstrap. Login + A2 landing only (per-screen views arrive in F1..Fn).
// Routing and the nav are driven by /me/landing, so a user only ever sees the
// modules their role permits (A2); the server enforces the same per endpoint.
import { api, session } from './api.js';
import { renderDirectory } from './directory.js';
import { renderProfile } from './profile.js';
import { renderLeave } from './leave.js';
import { renderLiability } from './liability.js';
import { renderScorecard, renderMyKpis } from './kpi.js';
import { renderAttendance } from './attendance.js';
import { renderExact } from './exact.js';
import { renderAlerts } from './alerts.js';
import { renderSupport } from './support.js';
import { renderPolicy } from './policy.js';
import { renderControls } from './controls.js';
import { renderTenant } from './tenant.js';

const $ = (sel) => document.querySelector(sel);

function showLogin(message) {
  $('#app').innerHTML = `
    <section class="login">
      <h1>HCMOS</h1>
      ${message ? `<p class="error">${message}</p>` : ''}
      <form id="login-form">
        <input id="email" type="email" placeholder="email" autocomplete="username" required />
        <input id="password" type="password" placeholder="password" autocomplete="current-password" required />
        <input id="mfa" inputmode="numeric" placeholder="6-digit code" required />
        <button type="submit">Sign in</button>
      </form>
    </section>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.login($('#email').value.trim(), $('#password').value, $('#mfa').value.trim());
      await showLanding();
    } catch (err) {
      showLogin(err.status === 401 ? 'Authentication failed.' : (err.message || 'Sign-in error.'));
    }
  });
}

async function showLanding() {
  let landing;
  try {
    landing = await api.landing();
  } catch (err) {
    session.clear();
    return showLogin(err.status === 401 ? 'Session expired — sign in again.' : 'Could not load your dashboard.');
  }
  // A2 guard: render ONLY the modules the role is permitted (server-authoritative
  // list). The Directory (F1) is an additional entry; access is enforced by the
  // API deny guard — a role without it sees the "no access" message.
  const nav = landing.modules.map((mod) => `<li data-module="${mod}">${mod}</li>`).join('');
  $('#app').innerHTML = `
    <header>
      <strong>HCMOS</strong>
      <span class="role">${landing.role} · ${landing.name}</span>
      <button id="logout">Sign out</button>
    </header>
    <nav><ul id="modules"><li data-view="directory">directory</li><li data-view="liability">liability</li><li data-view="scorecard">scorecard</li><li data-view="mykpis">my kpis</li><li data-view="attendance">clock in</li><li data-view="exact">payroll upload</li><li data-view="policy">policy</li><li data-view="support">support</li><li data-view="alerts">doc alerts</li><li data-view="controls">controls</li><li data-view="tenant">new tenant</li>${nav}</ul></nav>
    <main id="view"><p>Select a module.</p></main>`;
  $('#logout').addEventListener('click', () => { api.logout(); showLogin(); });

  const view = $('#view');
  const openProfile = (id) => renderProfile(view, id);
  $('[data-view="directory"]').addEventListener('click', () => renderDirectory(view, openProfile));

  // A2 module views: 'leave' is self-service; the server enforces access per endpoint.
  document.querySelectorAll('#modules [data-module="leave"]').forEach((li) =>
    li.addEventListener('click', () => renderLeave(view)));

  // Liability (pay-adjacent) — the endpoint is guarded to pay-visibility roles.
  const liab = document.querySelector('[data-view="liability"]');
  if (liab) liab.addEventListener('click', () => {
    const batch = prompt('Exact batch id for liability:');
    if (batch) renderLiability(view, batch);
  });
  $('[data-view="scorecard"]').addEventListener('click', () => renderScorecard(view));
  $('[data-view="mykpis"]').addEventListener('click', () => renderMyKpis(view));
  $('[data-view="attendance"]').addEventListener('click', () => renderAttendance(view));
  // Exact payroll upload (pay-adjacent) — the endpoints are guarded to the
  // pay-visibility role set; a role without it gets 403 on every call.
  $('[data-view="exact"]').addEventListener('click', () => renderExact(view));
  // F7: policy ack (self-service), support (self-service raise; agent lifecycle),
  // document alerts (compliance-guarded). Each endpoint enforces its own guard.
  $('[data-view="policy"]').addEventListener('click', () => renderPolicy(view));
  $('[data-view="support"]').addEventListener('click', () => renderSupport(view));
  $('[data-view="alerts"]').addEventListener('click', () => renderAlerts(view));
  // Controls & Checker (F7 #2) — guarded to the AUD/SOD set; all-clear evidence
  // grid distinct from the fail-with-offenders grid.
  $('[data-view="controls"]').addEventListener('click', () => renderControls(view));
  // F8: tenant provisioning wizard (C21) — platform-admin only; the endpoint 403s
  // any other role. Per-step flow with a distinct atomic-rollback result state.
  $('[data-view="tenant"]').addEventListener('click', () => renderTenant(view));
}

function boot() {
  if (session.isAuthed) showLanding();
  else showLogin();
}

boot();
