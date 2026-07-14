// F4 — KPI cards. Each card shows its RAG status and value/target, OR a
// NOT-AVAILABLE card naming the missing input (never a zero or a guessed %). The
// org scorecard is role-scoped and feature-flagged; My KPIs is self only.
import { api, presentCard } from './api.js';

function cardHtml(card) {
  const p = presentCard(card);
  if (p.kind === 'not-available') {
    return `<div class="card na"><h4>${card.name}</h4><p><em>Not available</em> — ${p.reason}</p></div>`;
  }
  const rag = p.rag || 'grey';
  return `<div class="card rag-${rag}"><h4>${card.name}</h4>
      <p class="value">${p.value}${p.target != null ? ` / ${p.target}` : ''}</p>
      <p class="status">${rag.toUpperCase()}</p></div>`;
}

// FOUR distinct render states for a KPI module (C3 scorecard AND E8 My KPIs),
// never a blank fall-through. Each carries a unique data-state so they can never
// be confused:
//   • module-disabled — analytics.enabled is OFF (TENANT-WIDE, overrides role): a
//     whole-module panel EXPLAINING it is switched off + an enable-pointer.
//   • no-permission   — the requester is not allowed the module (endpoint 403).
//   • empty           — flag on, allowed, but no cards to show.
//   • ready           — flag on, cards present.
export function moduleDisabledView(title) {
  return `<div class="kpi-module kpi-disabled" data-state="module-disabled">
      <h3>${title}</h3>
      <p class="module-off">The ${title} module is switched off for this client — analytics is not enabled.</p>
      <p class="enable-pointer">Enable the Analytics add-on in tenant configuration to switch this module on.</p>
    </div>`;
}

export function noPermissionView(title) {
  return `<div class="kpi-module kpi-no-permission" data-state="no-permission">
      <h3>${title}</h3>
      <p class="no-permission">You do not have access to ${title}.</p>
    </div>`;
}

// Pure: a {enabled, cards} payload → HTML. Flag-off (enabled:false) ALWAYS wins,
// regardless of role/cards — the tenant-wide disabled panel.
export function kpiView(payload, title) {
  if (!payload || !payload.enabled) return moduleDisabledView(title);
  const cards = payload.cards || [];
  if (cards.length === 0) {
    return `<div class="kpi-module" data-state="empty"><h3>${title}</h3><p class="empty">No KPIs to show yet.</p></div>`;
  }
  return `<div class="kpi-module" data-state="ready"><h3>${title}</h3><div class="cards">${cards.map(cardHtml).join('')}</div></div>`;
}

export async function renderScorecard(el) {
  let sc;
  try { sc = await api.scorecard(); }
  catch (e) { el.innerHTML = e.status === 403 ? noPermissionView('Scorecard') : `<p>Could not load the scorecard.</p>`; return; }
  el.innerHTML = kpiView(sc, 'Scorecard');
}

export async function renderMyKpis(el) {
  let mine;
  try { mine = await api.myKpis(); }
  catch (e) { el.innerHTML = e.status === 403 ? noPermissionView('My KPIs') : `<p>Could not load your KPIs.</p>`; return; }
  el.innerHTML = kpiView(mine, 'My KPIs');
}
