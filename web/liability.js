// F3 — leave liability view (pay-adjacent, confidential). Reachable only by the
// pay-visibility roles; a role without pay visibility gets 403 → the "no access"
// message. Figures come from the ONE name-keyed base ÷ 30, active staff only;
// an employee with no captured remuneration shows a NOT-AVAILABLE card naming the
// missing input — never a zero.
import { api } from './api.js';

export async function renderLiability(el, batchId) {
  let res;
  try { res = await api.liabilityBatch(batchId); }
  catch (e) {
    el.innerHTML = `<p>${e.status === 403 ? 'Leave liability is restricted to pay-visibility roles.' : 'Could not load liability.'}</p>`;
    return;
  }

  const rows = res.available.map((a) =>
    `<tr><td>${a.employee_id}</td><td>${a.days}</td><td>${a.daily_rate}</td><td>${a.liability}</td></tr>`).join('');
  const na = (res.not_available || []).map((n) =>
    `<li>${n.employee_id}: <em>Not available</em> — ${n.missing}</li>`).join('');
  const excluded = (res.excluded || []).map((x) => `<li>${x.employee_id} (${x.status})</li>`).join('');

  el.innerHTML = `
    <div class="liability">
      <h3>Leave liability</h3>
      <p>Total: <strong>${res.total}</strong> (active staff only)</p>
      <table>
        <thead><tr><th>Employee</th><th>Days</th><th>Daily rate</th><th>Liability</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">No liability.</td></tr>'}</tbody>
      </table>
      <h4>Not available (missing input)</h4><ul>${na || '<li>None.</li>'}</ul>
      <h4>Excluded (leavers)</h4><ul>${excluded || '<li>None.</li>'}</ul>
    </div>`;
}
