// F0 — app bootstrap. Login + A2 landing only (per-screen views arrive in F1..Fn).
// Routing and the nav are driven by /me/landing, so a user only ever sees the
// modules their role permits (A2); the server enforces the same per endpoint.
import { api, session } from './api.js';
import { renderDirectory } from './directory.js';
import { renderProfile } from './profile.js';

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
    <nav><ul id="modules"><li data-view="directory">directory</li>${nav}</ul></nav>
    <main id="view"><p>Select a module.</p></main>`;
  $('#logout').addEventListener('click', () => { api.logout(); showLogin(); });

  const view = $('#view');
  const openProfile = (id) => renderProfile(view, id);
  $('[data-view="directory"]').addEventListener('click', () => renderDirectory(view, openProfile));
  // Further per-screen views (F2..Fn) mount into #view the same way.
}

function boot() {
  if (session.isAuthed) showLanding();
  else showLogin();
}

boot();
