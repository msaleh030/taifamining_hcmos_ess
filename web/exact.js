// F6 — Exact payroll integration screen (pay-guarded). Drives the pipeline:
// upload → schema-validate → reconcile (unmatched report) → control-totals →
// publish. The SAFETY NETS are surfaced as blocking states, never warnings:
//   • a schema-invalid file is REJECTED at upload (422) — nothing is ingested;
//   • control totals that don't reconcile BLOCK publish (409) — no click-past;
//   • a published batch is READ-ONLY (the screen offers no mutation of pay).
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function renderExact(el) {
  el.innerHTML = `
    <div class="exact">
      <h3>Exact payroll upload</h3>
      <form id="ex-upload">
        <input id="ex-period" placeholder="period (e.g. 2026-06)" />
        <textarea id="ex-csv" rows="6" placeholder="paste the Exact CSV export"></textarea>
        <fieldset><legend>declared control totals</legend>
          <input id="ex-tp" inputmode="decimal" placeholder="total pay" />
          <input id="ex-td" inputmode="decimal" placeholder="total deduction" />
          <input id="ex-net" inputmode="decimal" placeholder="net" />
        </fieldset>
        <button type="submit">Upload &amp; validate</button>
      </form>
      <p id="ex-msg"></p>
      <div id="ex-batch"></div>
    </div>`;

  const msg = el.querySelector('#ex-msg');
  const panel = el.querySelector('#ex-batch');
  let batchId = null;

  el.querySelector('#ex-upload').addEventListener('submit', async (e) => {
    e.preventDefault();
    panel.innerHTML = '';
    const control_totals = {
      total_pay: el.querySelector('#ex-tp').value.trim() || null,
      total_deduction: el.querySelector('#ex-td').value.trim() || null,
      net: el.querySelector('#ex-net').value.trim() || null,
    };
    try {
      const out = await api.exactUpload({ period: el.querySelector('#ex-period').value.trim(),
        csv: el.querySelector('#ex-csv').value, control_totals });
      batchId = out.batch_id;
      msg.className = 'ok';
      msg.textContent = `Staged batch ${out.batch_id} — ${out.row_count} rows${out.deduped ? ' (already loaded)' : ''}.`;
      renderPipeline();
    } catch (err) {
      // Schema-fail is a BLOCK: the file is rejected, nothing ingested.
      msg.className = 'blocked';
      const details = err.body && err.body.errors ? ': ' + err.body.errors.join('; ') : '';
      msg.textContent = err.status === 422 ? `File rejected — schema invalid${details}. Nothing was ingested.` : (err.message || 'Upload failed.');
    }
  });

  function renderPipeline() {
    panel.innerHTML = `
      <div class="pipeline">
        <button id="ex-reconcile">Reconcile (match)</button>
        <button id="ex-net">Net check</button>
        <button id="ex-totals">Control totals</button>
        <button id="ex-publish">Publish</button>
        <div id="ex-out"></div>
      </div>`;
    const out = panel.querySelector('#ex-out');

    panel.querySelector('#ex-reconcile').addEventListener('click', async () => {
      const rep = await api.exactReconcile(batchId);
      const list = rep.unmatched.map((u) => `<li>${esc(u.employee_id)}</li>`).join('');
      out.innerHTML = `<p>Matched ${rep.matched} on ${esc(rep.key)}.</p>` +
        (rep.unmatched.length ? `<p class="warn">Unmatched (${rep.unmatched.length}):</p><ul>${list}</ul>` : `<p>All rows matched.</p>`);
    });

    panel.querySelector('#ex-net').addEventListener('click', async () => {
      const r = await api.exactNetCheck(batchId);
      out.innerHTML = r.mismatches.length
        ? `<p class="warn">Net mismatches on rows: ${r.mismatches.map((m) => m.row_no).join(', ')}.</p>`
        : `<p>Per-row net check passed (${r.checked} rows).</p>`;
    });

    panel.querySelector('#ex-totals').addEventListener('click', async () => {
      const r = await api.exactControlTotals(batchId);
      out.innerHTML = r.ok
        ? `<p>Control totals reconcile (net ${r.computed.net}).</p>`
        : `<p class="blocked">Control totals do NOT reconcile: ${r.mismatches.map((m) => `${m.field} declared ${m.declared} vs computed ${m.computed}`).join('; ')}.</p>`;
    });

    panel.querySelector('#ex-publish').addEventListener('click', async () => {
      try {
        const p = await api.exactPublish(batchId);
        out.innerHTML = `<p class="ok">Published batch ${esc(p.batch_id)}. Payslips are now read-only.</p>`;
        panel.querySelector('#ex-publish').disabled = true; // read-only after publish
      } catch (err) {
        // Totals mismatch / pending match are BLOCKS, not warnings.
        const why = err.body && err.body.mismatches
          ? ': ' + err.body.mismatches.map((m) => `${m.field} ${m.declared}≠${m.computed}`).join('; ')
          : (err.message ? ': ' + err.message : '');
        out.innerHTML = `<p class="blocked">Publish blocked${why}.</p>`;
      }
    });
  }
}
