# HCMOS™ — Taifa Human Capital Operating System

Commercial multi-tenant enterprise HR + payroll SaaS. Customer zero: Taifa Mining and Civil
Limited (Tanzania). Governed HCM is the system of record; ESS writes only through governed HCM
workflows. This repository is the **canonical, complete codebase** (Node.js / CommonJS, Postgres
+ RLS). Work locally on a branch, commit, push, PR — never edit the deployed box directly.

## Design System
The **canonical, authoritative** design reference is `design/HCMOS-Design-Spec.html` — the
screen-by-screen Visual Build Specification agreed with Design (14 console + ESS screens, each
with token redlines, component rules, and the full state set; 4 themes × 4 surfaces). The
deployed UI must match its embeds and honour its tokens.

`DESIGN.md` is the concise digest (Foundations F1–F7 + governance law) — read it first for
tokens/colours/type/spacing, then open the HTML spec for screen-level redlines. **When the two
disagree, the HTML spec wins.** Current tokens: cool-grey canvas `#EEF1F3` + green accent
`#1FA24A` + IBM Plex Sans/Mono + bento grid. Self-host fonts as WOFF2 — no CDN (thin field
connectivity). Do not deviate without explicit user approval.

## Governance rules (enforce in code + flag in QA)
- Pay wording: **Total Pay / Net Pay** (Net = Total Pay − Total Deduction) — never "Total Allowance".
- Confidential fields (pay/bank, medical, disciplinary): **absent, not masked** for roles without entitlement.
- Generated IDs `TMCL-<LOC>-<SEQ>`, non-editable. N/A **names its missing input**, never a blank/zero.
- Leavers excluded from live populations/totals. Maker ≠ checker (SoD). One primary action per surface.
- Multi-tenant isolation is enforced by Postgres RLS — never bypass it outside the sanctioned
  `SECURITY DEFINER` login bootstrap.
