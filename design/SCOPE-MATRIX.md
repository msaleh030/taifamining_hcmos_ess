# Surface / theme scope — RULING 2 (Kira, 2026-07-14)

Recorded so nobody signs off against the wrong bar.

## IN SCOPE — Phase 1
| Axis | In scope |
|---|---|
| Themes | **Light**, **Dark** |
| Surfaces | **Desktop**, **Mobile**, **Kiosk** (confirmed by Kira same day — shared devices are how the field clocks in) |
| States | **All 8** (empty · loading · populated · large-data · error · no-permission · offline · success) — function, not polish |
| Languages | **EN + SW** on every built screen — function, not polish |

## DEFERRED — drawn in the reference, NOT Phase 1, re-acceptance later
- **Liquid Glass** theme
- **Reduced-transparency** theme
- **Tablet** surface

The reference freeze (design/reference-2026-07/) still carries all four themes and
four surfaces; builds verify file hashes against MANIFEST.sha256 and implement to
the IN-SCOPE matrix above. Visual parity baselines are accepted against
light/dark × desktop/mobile (+ kiosk where the screen has a kiosk state).

## Device models (RULINGS, same day)
- **Personal phone**: one device, one person, bound at enrolment; PIN + possession.
  Shipped in P1 — nothing to rebuild.
- **Shared kiosk**: device enrolled to a SITE; PIN identifies the person;
  session is CLOCK-IN/OUT ONLY (server-side), auto-logout the instant a punch
  completes; **PIN + photo-on-punch** (photo records, never blocks; missing
  photo flags the record for site-HR review; no gallery, no recognition, no
  pooling — TZ PDPA scoping, one photo per punch). Kira is confirming the
  data-protection position separately.
