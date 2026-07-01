// F7 — Support tickets. Raising is self-service; the list is record-scoped by the
// server (a raiser sees only their own, a support agent sees all). Driving the
// lifecycle (transition) is a support-agent action — the endpoint 403s otherwise,
// so this screen simply surfaces that.
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const NEXT = { open: ['in_progress', 'closed'], in_progress: ['resolved', 'closed'], resolved: ['closed', 'in_progress'], closed: [] };

export function renderSupport(el) {
  el.innerHTML = `
    <div class="support">
      <h3>Support</h3>
      <form id="s-raise">
        <input id="s-subject" placeholder="subject" required />
        <input id="s-body" placeholder="details" />
        <select id="s-channel"><option value="in_app">in-app</option><option value="email">email</option></select>
        <button>Raise ticket</button>
      </form>
      <p id="s-msg"></p>
      <div id="s-list"></div>
    </div>`;
  const msg = el.querySelector('#s-msg');
  const list = el.querySelector('#s-list');

  async function refresh() {
    let out;
    try { out = await api.supportList(); }
    catch (err) { list.innerHTML = '<p>Could not load tickets.</p>'; return; }
    const rows = out.tickets.map((t) => {
      const moves = (NEXT[t.status] || []).map((to) =>
        `<button data-id="${t.id}" data-to="${to}">${to.replace('_', ' ')}</button>`).join(' ');
      return `<li>#${esc(t.id.slice(0, 8))} — ${esc(t.subject)} <strong>[${esc(t.status)}]</strong> ${moves}</li>`;
    }).join('');
    list.innerHTML = `<p class="scope">Showing: ${esc(out.scope)}</p><ul class="tickets">${rows || '<li>No tickets.</li>'}</ul>`;
    // Transition buttons — a non-agent gets 403 (surfaced), only agents drive lifecycle.
    list.querySelectorAll('button[data-to]').forEach((b) => b.addEventListener('click', async () => {
      try { await api.supportTransition(b.dataset.id, b.dataset.to); refresh(); }
      catch (err) { msg.className = 'blocked'; msg.textContent = err.status === 403 ? 'Only support can change ticket status.' : (err.message || 'Transition failed.'); }
    }));
  }

  el.querySelector('#s-raise').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.supportRaise({ subject: el.querySelector('#s-subject').value.trim(),
        body: el.querySelector('#s-body').value.trim(), channel: el.querySelector('#s-channel').value });
      msg.className = 'ok'; msg.textContent = 'Ticket raised.';
      el.querySelector('#s-subject').value = ''; el.querySelector('#s-body').value = '';
      refresh();
    } catch (err) { msg.className = 'blocked'; msg.textContent = err.message || 'Could not raise ticket.'; }
  });
  refresh();
}
