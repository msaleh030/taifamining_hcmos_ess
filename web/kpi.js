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

export async function renderScorecard(el) {
  let sc;
  try { sc = await api.scorecard(); }
  catch (e) { el.innerHTML = `<p>Could not load the scorecard.</p>`; return; }
  if (!sc.enabled) {
    el.innerHTML = `<div class="scorecard"><p>Analytics is not enabled for this client.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="scorecard"><h3>Scorecard</h3><div class="cards">${sc.cards.map(cardHtml).join('')}</div></div>`;
}

export async function renderMyKpis(el) {
  let mine;
  try { mine = await api.myKpis(); }
  catch (e) { el.innerHTML = `<p>Could not load your KPIs.</p>`; return; }
  el.innerHTML = `<div class="scorecard"><h3>My KPIs</h3><div class="cards">${mine.cards.map(cardHtml).join('')}</div></div>`;
}
