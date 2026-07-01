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

// Pure view: turn a scorecard payload into HTML. THREE distinct states, never a
// blank fall-through (C3):
//   • module-disabled — the analytics feature-flag is OFF for this client. A whole-
//     module panel that EXPLAINS it is switched off + points at how to enable it.
//     Distinct from empty (flag on, nothing to show) and from no-permission.
//   • empty           — flag on but no cards yet.
//   • ready           — flag on, cards present.
export function scorecardView(sc) {
  if (!sc || !sc.enabled) {
    return `<div class="scorecard scorecard-disabled" data-state="module-disabled">
      <h3>Scorecard</h3>
      <p class="module-off">The Scorecard module is switched off for this client — analytics is not enabled.</p>
      <p class="enable-pointer">Enable the Analytics add-on in tenant configuration to switch this module on.</p>
    </div>`;
  }
  const cards = sc.cards || [];
  if (cards.length === 0) {
    return `<div class="scorecard" data-state="empty"><h3>Scorecard</h3><p class="empty">No KPIs to show yet.</p></div>`;
  }
  return `<div class="scorecard" data-state="ready"><h3>Scorecard</h3><div class="cards">${cards.map(cardHtml).join('')}</div></div>`;
}

export async function renderScorecard(el) {
  let sc;
  try { sc = await api.scorecard(); }
  catch (e) { el.innerHTML = `<p>Could not load the scorecard.</p>`; return; }
  el.innerHTML = scorecardView(sc);
}

export async function renderMyKpis(el) {
  let mine;
  try { mine = await api.myKpis(); }
  catch (e) { el.innerHTML = `<p>Could not load your KPIs.</p>`; return; }
  el.innerHTML = `<div class="scorecard"><h3>My KPIs</h3><div class="cards">${mine.cards.map(cardHtml).join('')}</div></div>`;
}
