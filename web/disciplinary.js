// F2 — disciplinary action + fan-out screen (C8). One confirmed submission fans
// out server-side (register entry + ESS notice + manager/HR alert + warning letter
// + activity feed + audit) in a single transaction. SoD (subject ≠ self, issuer ≠
// checker, permitted roles) is enforced at the endpoint; the screen just reports
// the outcome or the refusal reason.
import { api } from './api.js';

const TYPES = ['verbal', 'written', 'final', 'suspension'];

export function renderDisciplinary(el, employeeId, onDone) {
  el.innerHTML = `
    <div class="disciplinary">
      <h3>Disciplinary action</h3>
      <form id="disc" class="filters">
        <select id="type">${TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
        <input id="detail" placeholder="detail" />
        <input id="approver" placeholder="approver user id (checker)" />
        <button type="submit">Confirm &amp; issue</button>
        ${onDone ? '<button type="button" id="back">Back</button>' : ''}
      </form>
      <p id="d-msg"></p>
    </div>`;

  const msg = el.querySelector('#d-msg');
  el.querySelector('#disc').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const out = await api.issueDiscipline(employeeId, {
        actionType: el.querySelector('#type').value,
        detail: el.querySelector('#detail').value,
        approverUserId: el.querySelector('#approver').value.trim(),
      });
      msg.textContent = `Issued (${out.action_type}) — manager: ${out.manager || 'n/a'}` + (out.suspended ? ', employee suspended.' : '.');
    } catch (err) {
      msg.textContent = err.status === 403
        ? `Refused: ${err.message}` // e.g. cannot act on self / issuer≠checker / not permitted
        : 'Could not issue the action (nothing was recorded).';
    }
  });
  if (onDone) el.querySelector('#back').addEventListener('click', onDone);
}
