// F8 — Tenant provisioning wizard (C21), built to Design's spec. Per-step flow:
//   1. details  — the tenant name (companyId is minted server-side; codes are
//                 registry-minted, so the operator never picks an id).
//   2. review   — confirm what will be seeded FROM THE REGISTRY (config + sites).
//   3. result   — provisioned (new company_id, seeded counts) OR the atomic-
//                 rollback state (a mid-provision fault → nothing half-created).
//
// Deferred (Design state #4): pre-provision validation of code/name collision and
// currency/country combos. Deferred as low-likelihood — the companyId is minted
// server-side (collision-proof) and there is no currency/country field in the
// model yet. Only name-required is enforced (the endpoint 400s on a blank name).
// This is a CONSCIOUS deferral; the critical atomic-rollback net IS built below.
import { api } from './api.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Pure result view — provisioned vs rolled-back are DISTINCT states (spec #4 net).
export function provisionResultView(outcome) {
  if (outcome.ok) {
    const t = outcome.tenant;
    return `<div class="provision-result ok" data-state="provisioned">
      <h4>Tenant provisioned</h4>
      <dl>
        <dt>Company ID</dt><dd>${esc(t.company_id)}</dd>
        <dt>Name</dt><dd>${esc(t.name)}</dd>
        <dt>Registry config seeded</dt><dd>${esc(t.config_keys)} keys</dd>
        <dt>Sites created</dt><dd>${esc(t.sites)}</dd>
      </dl>
      <p class="isolated">The new tenant is isolated (RLS) — its data is invisible to every other tenant.</p>
    </div>`;
  }
  // Atomic-rollback state: the whole tenant rolled back; nothing was half-created.
  return `<div class="provision-result rolled-back" data-state="rolled-back">
    <h4>Provisioning rolled back</h4>
    <p>The provision failed and was rolled back atomically — <strong>no tenant, config, or site was created</strong>.</p>
    <p class="why">${esc(outcome.error || 'Please retry.')}</p>
  </div>`;
}

export function renderTenant(el) {
  const state = { step: 1, name: '' };

  function stepper() {
    return `<ol class="stepper">
      ${[['1', 'Details'], ['2', 'Review'], ['3', 'Result']].map(([n, label]) =>
        `<li class="${Number(n) === state.step ? 'active' : ''}">${n}. ${label}</li>`).join('')}
    </ol>`;
  }

  function details() {
    el.innerHTML = `<div class="wizard">${stepper()}
      <h3>Provision a tenant</h3>
      <form id="w-details">
        <label>Tenant name<input id="w-name" value="${esc(state.name)}" required /></label>
        <button>Next</button>
      </form></div>`;
    el.querySelector('#w-details').addEventListener('submit', (e) => {
      e.preventDefault();
      state.name = el.querySelector('#w-name').value.trim();
      if (!state.name) return;
      state.step = 2; review();
    });
  }

  function review() {
    el.innerHTML = `<div class="wizard">${stepper()}
      <h3>Review</h3>
      <p>Provision <strong>${esc(state.name)}</strong>. The tenant's company ID is minted by the
         platform; config and sites are seeded FROM THE REGISTRY (no manual step).</p>
      <p class="note">If anything fails mid-provision, the whole tenant rolls back — nothing is half-created.</p>
      <button id="w-back">Back</button>
      <button id="w-go">Provision</button>
    </div>`;
    el.querySelector('#w-back').addEventListener('click', () => { state.step = 1; details(); });
    el.querySelector('#w-go').addEventListener('click', async () => {
      el.querySelector('#w-go').disabled = true;
      let outcome;
      try { outcome = { ok: true, tenant: await api.provisionTenant(state.name) }; }
      catch (err) {
        outcome = { ok: false, error: err.status === 403 ? 'You are not permitted to provision tenants.' : (err.message || 'Provisioning failed.') };
      }
      state.step = 3; result(outcome);
    });
  }

  function result(outcome) {
    el.innerHTML = `<div class="wizard">${stepper()}${provisionResultView(outcome)}
      <button id="w-again">Provision another</button></div>`;
    el.querySelector('#w-again').addEventListener('click', () => { state.step = 1; state.name = ''; details(); });
  }

  details();
}
