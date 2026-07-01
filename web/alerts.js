// F7 — Document-expiry alerts (DA-1/DA-2). Compliance/HR view: the endpoint is
// guarded to the document-compliance owners, so a role without access gets a
// clear "no access" message rather than a blank screen. Each alert names the
// DA-2 role it was routed to.
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function renderAlerts(el) {
  el.innerHTML = `
    <div class="alerts">
      <h3>Document expiry alerts</h3>
      <form id="a-run"><input id="a-asof" placeholder="as-of YYYY-MM-DD" /><button>Run sweep</button></form>
      <p id="a-msg"></p>
      <div id="a-list"></div>
    </div>`;
  const msg = el.querySelector('#a-msg');
  const list = el.querySelector('#a-list');

  function draw(rows) {
    list.innerHTML = rows.length
      ? `<ul class="alert-list">${rows.map((a) =>
          `<li>${esc(a.kind)} — due ${esc(a.due_date)} → <strong>${esc(a.notify_role || 'unassigned')}</strong> (×${esc(a.notify_count || 1)})</li>`).join('')}</ul>`
      : '<p>No open alerts.</p>';
  }
  async function load() {
    try { draw((await api.alerts()).open); }
    catch (err) { list.innerHTML = err.status === 403 ? '<p>You do not have access to document alerts.</p>' : '<p>Could not load alerts.</p>'; }
  }

  el.querySelector('#a-run').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api.alertsRun(el.querySelector('#a-asof').value.trim() || undefined);
      msg.className = 'ok'; msg.textContent = `Swept: ${r.raised.length} raised, ${r.cleared.length} cleared, ${r.open_count} open.`;
      load();
    } catch (err) { msg.className = 'blocked'; msg.textContent = err.status === 403 ? 'You do not have access to run the sweep.' : (err.message || 'Sweep failed.'); }
  });
  load();
}
