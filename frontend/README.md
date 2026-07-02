# HCMOS/ESS designed frontend

React 18 + TypeScript + Vite · Tailwind + owned (shadcn-style) components ·
TanStack Query · React Router · one PWA serving BOTH the console and ESS
tracks (vite-plugin-pwa/Workbox; IndexedDB offline clock-in) · react-i18next
EN/SW · static build behind Cloudflare. **The backend is unchanged** — this is
a same-origin client of the certified HCMOS API.

## Authority boundary

- **Design spec** (HCMOS Design Spec + its 17 prototypes + canonical
  `styles.css`) — authority for how it **looks**: tokens, layout, components,
  states.
- **Registry + certified backend** — authority for **behaviour and gating**.
  The functional layer here is a 1:1 typed port of the certified vanilla
  scaffold (`web/*.js`), which is the functional spec. No gate is implemented
  from the design doc; where the doc and backend ever conflict, the backend
  wins and the doc is corrected.
- View layer only. Any screen that would need a backend change **stops** and
  goes to Kira.

## Status: source-complete, build-pending — NOT at visual par

Authored in a session whose network policy blocks npm (registry 403), so
`npm install` / `vite build` / `tsc` have **not** run here yet, and the design
spec bundle was not reachable from the session. Two unblocks, both Kira-side:

1. **npm access** — allowlist `registry.npmjs.org` in the Claude Code
   environment network policy (or build on the UAT box / CI, which reach npm).
2. **The spec bundle** — deliver Design's canonical `styles.css` (+ the spec
   doc / prototypes) into the repo or session.

## Token single-source rule (Kira's step 1)

`src/styles/tokens.css` is a **placeholder**. The canonical `styles.css` is
committed verbatim in its place only after confirming the F7 reconciliation
(the divergence table's promotions) is actually **in** the file — if it lives
only in the spec's prose, it is landed in styles.css first and flagged to
Design. `tailwind.config.ts` maps all utilities onto those custom properties;
no visual literal lives in components.

## Structure

- `src/lib/api.ts` — the typed API client (port of `web/api.js`), sessionStorage
  token, backend-status error surfacing. `CONFIDENTIAL_FIELDS` + `presentCard`
  carry the absent-not-masked and not-available-never-zero conventions.
- `src/lib/offline.ts` — IndexedDB punch queue: offline clock-ins replay with
  their ORIGINAL idempotency key (records once); the server always decides.
- `src/lib/i18n.ts`, `src/locales/` — EN authoritative (carries the wording
  locks); SW draft, locked terms fall back to EN until the Swahili wording is
  signed.
- `src/components/ui.tsx` — owned primitives; placeholder skins, final
  semantics (`data-state` hooks the ACs assert on).
- `src/screens/*` — one file per screen, behaviour ported 1:1; the JSX view is
  the part swapped to each redline during the visual-parity pass.

## Parity bar (per screen, in order, before the next screen starts)

A screen is at par only when it:
(a) passes its existing functional AC-ID against the live API,
(b) visually matches the spec's redline (Playwright screenshot baseline at the
    spec's viewports, accepted by Design, held by CI), and
(c) renders every enumerated state — the 5 universal states plus the screen's
    nets and confidentiality-conditional views.

Until each screen clears that bar, the vanilla scaffold (`web/`) remains the
functional preview on UAT; this build replaces it only when designed screens
land.

## Commands (once npm is reachable)

```
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # vite dev server, proxies API prefixes to :3000
npm run build       # typecheck + vite build → dist/
```

`public/icons/` needs the PWA icons (192/512) from Design's asset kit.
