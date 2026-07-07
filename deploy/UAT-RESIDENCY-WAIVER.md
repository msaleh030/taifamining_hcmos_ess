# UAT data-residency waiver (on the record)

**Decision:** the UAT instance runs on **Hostinger — Europe** region, accepted by
**Kira**. The DPA/registry commitment is **af-south-1 (Cape Town)** (`region:
af-south-1` in the registry, unchanged); Hostinger has no South-Africa region, so
this is a **conscious, documented exception**, not a silent compromise.

**Scope of the waiver — strictly limited:**
- **UAT only, TEST data only.** No production/real personal data is placed on the
  EU origin under this waiver. The data stays TEST until the carry policy lands.
- **Production MUST be in-region (af-south-1) or an agreed compliant location.** The
  registry value is NOT changed; `region: af-south-1` remains the production target.
- The waiver covers the **origin compute + Postgres** location only. Cloudflare's
  global edge already fronts the origin; authenticated API responses are not cached
  (see the runbook).

**Still enforced on the EU box (no posture relaxation beyond location):**
- scram-sha-256, no trust auth, Postgres bound to localhost, secrets in the store
  (not the repo), Cloudflare Access gating to named testers, nightly in-region
  (EU) backups + a tested restore.

**Revisit:** before any production/real-data load, replace the EU origin with an
af-south-1 (or agreed compliant) origin, or obtain a further explicit decision.

## Production residency — flagged on record (Kira, 2026-07-06)

The provider's full data-centre catalogue for this account contains **no
African region** (EU: Frankfurt/Paris/Vilnius; UK; IN; ID; MY; BR; US).
UAT proceeds in **Frankfurt (DE)** under this waiver — EU, TEST data only.
**Production residency needs a real decision before go-live**: an
Africa-capable provider (registry `af-south-1` stands), or a documented
EU-hosting lawful basis. Separate Kira decision; not blocked by UAT.

## Production posture — DECIDED (Kira, 2026-07-06, later the same day)

**Production stays on Hostinger** in the region of choice, under the
**documented lawful basis** route — NOT an African provider (Kira's call;
supersedes the open question above; the registry `af-south-1` value is
retired as the production target once the lawful-basis documentation lands).

**Region = lowest measured RTT to Tanzania, chosen empirically, never
assumed.** Contenders from the catalogue: **Frankfurt (DC 19)** — current
UAT — vs **Mumbai (DC 23)** — likely favoured by the Indian-Ocean cable
paths to Dar es Salaam. Measurement: East-Africa probes (Globalping;
Tanzania first, neighbours for corroboration) against paired neutral
Frankfurt/Mumbai targets plus the real Hostinger Frankfurt box — see
`.github/workflows/latency-probe.yml`. **UAT stays Frankfurt as-is**
regardless of the production pick.

**Measured + CONFIRMED (Kira, 2026-07-06): FRANKFURT.** The shootout (run
28819468970; no Tanzania probes existed, so Nairobi ×6 paths and Kampala ×2
carried it): median RTT **Frankfurt ~159–160 ms vs Mumbai ~264–268 ms** —
Frankfurt by ~100 ms with 0% loss on every path, while Mumbai paths showed
11% loss and 570 ms+ jitter spikes. East-African transit egresses via the
Mombasa landings toward Europe, so the Indian-Ocean prior did not survive
measurement. **Production region = Frankfurt**, to be verified with a ping
run from Taifa's own Dar es Salaam network before go-live
(`fra-de-ping.vultr.com` vs `bom-in-ping.vultr.com`).
