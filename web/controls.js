// F7 — Controls & Checker screen (AC-AUD-03), built against Design spec #2. TWO
// distinct grids, never conflated:
//   • all-clear   — every control green, each showing its checked-count as audit
//                   evidence ("N checked, 0 offenders"). data-state="all-clear".
//   • findings    — one or more controls failed; the offending rows are listed
//                   per failing control. data-state="findings".
// The endpoint is guarded to the AUD/SOD set, so a role without access sees a
// distinct "no access" panel, not a blank screen.
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const LABEL = {
  'sod.self_approval': 'Segregation of duties (no self-approval)',
  'attendance.no_location': 'Attendance has location evidence',
  'access.leaver_retained': 'No access retained by leavers',
  'audit.chain_integrity': 'Audit chain integrity',
};

// Pure view. all_pass → the all-clear evidence grid; otherwise the findings grid.
export function controlsView(result) {
  const checks = result.checks || [];
  if (result.all_pass) {
    const rows = checks.map((c) =>
      `<li class="control ok"><span class="name">${esc(LABEL[c.check] || c.check)}</span>
         <span class="evidence">${esc(c.checked)} checked, 0 offenders</span></li>`).join('');
    return `<div class="controls all-clear" data-state="all-clear">
      <h3>Controls &amp; Checker</h3>
      <p class="banner">All controls clear.</p>
      <ul class="control-grid">${rows}</ul></div>`;
  }
  const rows = checks.map((c) => {
    if (c.pass) {
      return `<li class="control ok"><span class="name">${esc(LABEL[c.check] || c.check)}</span>
         <span class="evidence">${esc(c.checked)} checked, 0 offenders</span></li>`;
    }
    const offenders = c.offenders.map((o) => `<li>${esc(JSON.stringify(o))}</li>`).join('');
    return `<li class="control fail"><span class="name">${esc(LABEL[c.check] || c.check)}</span>
       <span class="evidence">${esc(c.checked)} checked, <strong>${c.offenders.length} offender(s)</strong></span>
       <ul class="offenders">${offenders}</ul></li>`;
  }).join('');
  return `<div class="controls findings" data-state="findings">
    <h3>Controls &amp; Checker</h3>
    <p class="banner">Findings require attention.</p>
    <ul class="control-grid">${rows}</ul></div>`;
}

export async function renderControls(el) {
  el.innerHTML = '<p>Running controls…</p>';
  let result;
  try { result = await api.controls(); }
  catch (err) {
    el.innerHTML = err.status === 403
      ? '<div class="controls no-permission" data-state="no-permission"><h3>Controls &amp; Checker</h3><p>You do not have access to the controls view.</p></div>'
      : '<p>Could not run controls.</p>';
    return;
  }
  el.innerHTML = controlsView(result);
}
