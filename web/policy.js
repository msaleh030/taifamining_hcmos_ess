// F7 — Policy acknowledgement (POL-02/03), self-service. Every employee reads
// the current policy version and acknowledges it; a new version re-opens the ack.
// Publishing (POL-01) and the outstanding report (POL-04) are admin/compliance
// endpoints, not part of this employee-facing screen.
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function renderPolicy(el, code = 'COND') {
  el.innerHTML = `
    <div class="policy">
      <h3>Policy</h3>
      <form id="p-load"><input id="p-code" value="${esc(code)}" placeholder="policy code" /><button>Open</button></form>
      <div id="p-body"></div>
    </div>`;
  const body = el.querySelector('#p-body');

  async function load(c) {
    body.innerHTML = 'Loading…';
    let p;
    try { p = await api.policyRead(c); }
    catch (err) { body.innerHTML = err.status === 404 ? `<p>No policy found for "${esc(c)}".</p>` : '<p>Could not load the policy.</p>'; return; }
    body.innerHTML = `
      <article class="policy-doc">
        <h4>${esc(p.title)} <span class="ver">v${esc(p.version)}</span></h4>
        <div class="policy-text">${esc(p.body || '')}</div>
      </article>
      <button id="p-ack">Acknowledge v${esc(p.version)}</button>
      <p id="p-msg"></p>`;
    body.querySelector('#p-ack').addEventListener('click', async () => {
      const msg = body.querySelector('#p-msg');
      try {
        const r = await api.policyAck(c);
        msg.className = 'ok';
        msg.textContent = `Acknowledged v${r.version}.`;
        body.querySelector('#p-ack').disabled = true;
      } catch (err) { msg.className = 'blocked'; msg.textContent = err.message || 'Acknowledgement failed.'; }
    });
  }

  el.querySelector('#p-load').addEventListener('submit', (e) => { e.preventDefault(); load(el.querySelector('#p-code').value.trim()); });
  load(code);
}
