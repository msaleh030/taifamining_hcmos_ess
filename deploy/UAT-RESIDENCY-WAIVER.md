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
