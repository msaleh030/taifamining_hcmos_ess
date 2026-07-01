// F1 — employee profile screen. Confidential fields are rendered ONLY if present
// in the API response: the server omits (A3) the fields a role may not see, so the
// UI never masks or guesses — absent means absent. Edits go through the
// maker-checker change-request flow (EMP-03); approval is separation-of-duties
// enforced server-side.
import { api } from './api.js';

const EDITABLE = ['phone', 'email', 'dept', 'home_address', 'full_name'];
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function renderProfile(el, id) {
  let emp;
  try {
    emp = await api.employee(id);
  } catch (e) {
    el.innerHTML = `<p>${e.status === 404 ? 'Not found, or outside your site.' : 'Could not load the profile.'}</p>`;
    return;
  }

  // Render only the fields present (confidential ones are omitted upstream by A3).
  const fields = Object.entries(emp).filter(([k]) => k !== 'pending_changes');
  const rows = fields.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const pending = (emp.pending_changes || [])
    .map((c) => `<li>${esc(c.field)}: ${esc(c.before)} → ${esc(c.after)} <button data-approve="${c.id}">Approve</button></li>`)
    .join('');

  el.innerHTML = `
    <div class="profile">
      <table>${rows}</table>
      <h3>Request a change</h3>
      <form id="chg" class="filters">
        <select id="field">${EDITABLE.map((f) => `<option>${f}</option>`).join('')}</select>
        <input id="value" placeholder="new value" />
        <button type="submit">Submit for approval</button>
      </form>
      <h3>Pending changes</h3>
      <ul id="pending">${pending || '<li>None.</li>'}</ul>
      <p id="p-msg"></p>
    </div>`;

  const msg = el.querySelector('#p-msg');
  el.querySelector('#chg').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.requestChange(id, el.querySelector('#field').value, el.querySelector('#value').value);
      renderProfile(el, id);
    } catch (err) {
      msg.textContent = err.status === 403 ? 'You are not permitted to request this change.' : 'Submit failed.';
    }
  });
  el.querySelectorAll('[data-approve]').forEach((btn) => btn.addEventListener('click', async () => {
    try {
      await api.approveChange(btn.dataset.approve);
      renderProfile(el, id);
    } catch (err) {
      msg.textContent = err.status === 403 ? 'You cannot approve this change (separation of duties).' : 'Approve failed.';
    }
  }));
}
