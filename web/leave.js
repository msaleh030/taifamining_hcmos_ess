// F3 — leave screen (self-service). Shows the annual balance and the SEPARATE
// sick bucket (its limit is not-available until LR-7 is set — shown as such, never
// a guessed number), and applies for leave. Annual enforces LR-5 (max continuous
// + HoH override) and available balance server-side.
import { api } from './api.js';

export async function renderLeave(el) {
  let bal;
  try { bal = await api.leaveBalance(); }
  catch (e) { el.innerHTML = `<p>Could not load leave balance.</p>`; return; }

  const sick = bal.sick.available && bal.sick.available.available === false
    ? `taken ${bal.sick.taken} · limit <em>Not available</em> (${bal.sick.available.missing})`
    : `taken ${bal.sick.taken}`;

  el.innerHTML = `
    <div class="leave">
      <h3>Leave balance</h3>
      <ul>
        <li>Annual: available <strong>${bal.annual.available}</strong>
            (entitlement ${bal.annual.entitlement} + carried ${bal.annual.carried} − taken ${bal.annual.taken})</li>
        <li>Sick: ${sick}</li>
      </ul>
      <h3>Apply for leave</h3>
      <form id="apply" class="filters">
        <select id="type"><option value="annual">annual</option><option value="sick">sick</option></select>
        <input id="days" type="number" min="0.5" step="0.5" placeholder="days" />
        <label><input id="hoh" type="checkbox" /> HoH override</label>
        <button type="submit">Apply</button>
      </form>
      <p id="l-msg"></p>
    </div>`;

  el.querySelector('#apply').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api.leaveApply({
        leave_type: el.querySelector('#type').value,
        days: Number(el.querySelector('#days').value),
        hoh_override: el.querySelector('#hoh').checked,
      });
      renderLeave(el);
    } catch (err) {
      el.querySelector('#l-msg').textContent = err.message || 'Could not apply for leave.';
    }
  });
}
