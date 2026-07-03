# Design System — HCMOS™ (Taifa Human Capital Operating System)

> **Canonical source of truth:** [`design/HCMOS-Design-Spec.html`](design/HCMOS-Design-Spec.html)
> — the authoritative, screen-by-screen Visual Build Specification agreed with Design (14 console
> + ESS screens, each with token redlines, component rules, and the full state set; 4 themes ×
> 4 surfaces). The deployed UI must match its embeds and honour its tokens. **This file is the
> concise token/rule digest of that spec** (Foundations F1–F7 + governance law). When this digest
> and the HTML spec disagree, **the HTML spec wins** and this file gets corrected.

Commercial multi-tenant enterprise HR + payroll SaaS. HCM is the governed system of record; ESS
writes only through governed HCM workflows. Design-system fidelity is the acceptance bar.

---

## Non-negotiable governance & wording (design is law here)
- **Pay wording:** always **Total Pay** and **Net Pay** (Net = Total Pay − Total Deduction).
  **Never** "Total Allowance".
- **Confidentiality:** confidential fields (pay/bank, medical, disciplinary) are **absent, not
  masked** for roles without entitlement — the section is not rendered at all. No masked
  placeholder, no "restricted" row.
- **Generated identifiers:** `TMCL-<LOC>-<SEQ>`, mono, **non-editable**.
- **Unavailable data:** an N/A value **names its missing input** — never a blank or a silent zero.
- **Leavers excluded** from live populations/totals.
- **Maker ≠ checker** (SoD): a requester can't approve their own request; issuer ≠ subject.
- **One primary action per surface.** Green is spent only on the single primary/active target.

## F1 · Colour
Neutral, slightly-cool greyscale carries structure; colour is spent only with intent.
Canonical **light** theme (values live once here; screens reference tokens, not pixels).

**Accent & status**
- **Green** `#1FA24A` → hover `#178A3E` — action, active nav, primary button, "on-target".
- **Blue** `#0094D4` — information, sync/queue, assigned assets. **Never the primary CTA.**
- **Yellow** `#FBC02D` (use text `#9A6B00` on light) — warn, offline, amber RAG.
- **Red** `#E5484D` — error, destructive, breach, off-target RAG. Confirmation-gated.
- **Soft fills:** green `rgba(31,162,74,.12)` · blue `rgba(0,148,212,.12)` · yellow
  `rgba(251,192,45,.16)` · red `rgba(229,72,77,.12)`.

**Neutrals (light)**
| Token | Value | Role |
|---|---|---|
| `--bg` | `#EEF1F3` | App canvas behind cards |
| `--surface` | `#FFFFFF` | Card / panel / sidebar |
| `--surface-2` | `#F6F8F9` | Inset fields, table hover, tiles |
| `--text` | `#15191D` | Primary ink |
| `--muted` | `#5C6770` | Secondary text, labels |
| `--faint` | `#8A949C` | Tertiary, captions, table headers |
| `--border` | `#E2E7EA` | Card & control borders |
| `--border-2` | `#EDF0F2` | Quiet inner dividers |

**Colour-with-intent rule:** green = action + the single active/primary target only; secondary
buttons stay neutral so the green primary reads as the decision. Decorative accents → `--faint`.

> **⚠️ Accessibility to confirm with Design (WCAG AA):** measured on white, `green #1FA24A`
> (3.32), `blue #0094D4` (3.39), `red #E5484D` (3.91), and `--faint #8A949C` (3.09; 2.72 on
> `--bg`) **fail AA (4.5:1) for normal-size text.** Use these only as fills, borders, icons, and
> large text. Never render semantic colours or `--faint` at body/caption size as the only signal.
> For the field/outdoor workforce, prefer darker text tokens for small text. (Body `--text` 17.7
> and `--muted` 5.79 pass.)

## F2 · Typography
**IBM Plex Sans** for everything structural; **IBM Plex Mono** (`--mono`, tabular figures) for
every number, ID, formula, timestamp, and code. Tight negative tracking on large weights;
body line-height 1.45. **Self-host WOFF2** (thin field connectivity) — do NOT load from a CDN.

| Use | Spec |
|---|---|
| Display / login h1 | 38 / 700 / −.025em |
| Page title `.page-t` | 18 / 680 / −.02em |
| KPI value (mono) | 30 / 600 / −.035em |
| Section heading `.sec-h h2` | 14 / 700 / .06em · UPPER |
| Card title `.card-h h3` | 14 / 650 |
| Body | 14 / 400 / 1.45 |
| Table / mono meta | 13 · 10–11 mono |
| Label / eyebrow | 10.5 / 600 / .06em |

## F3 · Spacing & layout
One padding token drives density; the console is a **bento grid of cards** over a scrolling
content region. Compact density tightens padding without touching type.
- `--pad` 20px (compact 13px) · content padding 26/28px · grid gap 18px (cards 16)
- card-h padding 15/20px · table cell 12.5/20px · sidebar width 244px
- **Primitive:** `.content` (scroll) → `.sec-h` group labels → `.grid` bento of `.card`.
  Rows/groups use flex/grid `gap`, never inline-flow whitespace. Each screen's redline names
  its grid **track counts**, not pixel widths.
- **Bento discipline:** bento is for overview/scorecard (mixed-span cards). Tables stay tables,
  pipelines stay pipelines, wizards stay wizards. A card that is just a number belongs in the
  KPI strip, not the bento.

## F4 · Radius & elevation
- `--r` 10px (cards, panels, inputs, buttons) · `--r-sm` 7px (nav, small controls, chips)
- pill 20–30px (tags, status pills, badges)
- `--shadow` resting card `0 1px 2px /.05 · 0 1px 3px /.04`
- `--shadow-l` lifted `0 6px 24px /.10` (drawers, modals, hover)

## F5 · Motion
Functional and short. Interaction feedback 120–150ms; overlays soft-decelerate; everything
decorative gated behind `prefers-reduced-motion`.
- control feedback `.12s ease` · border/shadow `.15s` · drawer in `.22s cubic-bezier(.2,.8,.2,1)`
- backdrop fade `.15s` · toast `.2s translateY` · skeleton shimmer `1.2s linear`
- geofence/sync pulse 2.4–3s (reduced-motion gated) · ID-card flip `.7s`
- Entrance animations animate **from hidden with the visible end-state as base** (so print,
  export, and reduced-motion users see content). No infinite decorative loops on content.

## F6 · Themes & surfaces
Every screen renders across **4 themes × 4 surfaces** (AC-UNI-03), driven by `[data-theme]`
and `[data-surface]` on the root.
- **Themes:** Light (default, F1) · Dark (`bg #0C1115` · `surface #141B20` · `text #E7EDF1`) ·
  Liquid Glass (translucent, 16px blur, tinted gradient) · Reduced-transparency (opaque
  high-contrast green, no blur — accessibility, first-class).
- **Surfaces:** Desktop console 1120×660 (sidebar shell, multi-column bento) · Tablet 760×600
  (grids 2-up; top-nav variant permitted) · Mobile ESS 390×760 (single column, 44px min hit
  target, bottom-safe) · Kiosk 720×840 (17px base, roomier targets, assisted flows).

> **Delivery order (recommendation):** ship **Light + Dark × Desktop + Mobile** first;
> Glass, Reduced-transparency, and Kiosk as fast-follow. The full 4×4 × 8-state × 14-screen
> matrix is ~1,700 renderings — don't let it block go-live.

## F7 · Divergence flags — `styles.css` is canonical
Build to canonical where the flow prototypes drifted:
- Content radius → `--r 10` / `--r-sm 7`; larger radii are surface chrome (device bezel/frame).
- Resting cards use the 2-layer `--shadow`; reserve the deep drop for `--shadow-l`.
- Promote per-flow state primitives (banner/note/center/seal/skelrow) into `styles.css`.
- Add the Glass & Reduced token blocks to the canonical sheet.
- Parametrise the shell on `[data-surface]` (desk/tab/mob/kiosk).
- Promote the general form-field kit (`.field`/`.fg`) to canonical for all console + ESS forms.

## Components (see HTML spec K1–K8 for redlines)
Navigation (244px sidebar, tricolor cap, one green active item) · Cards & bento · KPI tile
(`.kpi` dashboard + `.kcard` RAG scorecard) · Tables (mono/tabular numerics, avatar names,
clickable rows → profile drawer, virtualise 5k+) · Forms · Buttons (one primary/surface) ·
Tags & status (semantic soft-fill pills, label + colour + icon) · States (8 universal + screen
nets). Every status carries a non-colour signal (label/icon) — never colour alone.
