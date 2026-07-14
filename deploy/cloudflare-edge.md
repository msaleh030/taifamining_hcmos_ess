# Cloudflare edge — DNS, Access (zero-trust), cache

All configured in **your** Cloudflare account (dashboard or API from your side —
never share the token). Subdomain: `uat.taifamining.tz`.

## DNS record

**Option A — Tunnel (recommended, no open ports).** `cloudflared tunnel route dns
hcmos-uat uat.taifamining.tz` creates the record automatically. If adding by hand:

| Type  | Name  | Target                              | Proxy |
|-------|-------|-------------------------------------|-------|
| CNAME | `uat` | `<TUNNEL-UUID>.cfargotunnel.com`    | ✅ Proxied (orange) |

**Option B — Public IP + nginx/Caddy.** Only `443` open; origin cert from Cloudflare.

| Type | Name  | Target                | Proxy |
|------|-------|-----------------------|-------|
| A    | `uat` | `<origin box public IP>` | ✅ Proxied (orange) |

Proxied (orange cloud) so Cloudflare terminates TLS and fronts the origin.

## Access (zero-trust) — gate to named testers  (D-1)

Zero Trust → Access → Applications → **Add a self-hosted app**:
- Application domain: `uat.taifamining.tz`
- Policy: **Allow**, with these include rules:
  - **Emails ending in** `@taifamining.tz`   (covers all `firstname.lastname@taifamining.tz` Taifa testers)
  - **Email** `mohammed@railgrid.tz`          (Kira / RailGrid)
  - add any further named RailGrid testers individually
- Session duration: e.g. 24h. This makes the instance NOT world-reachable.

## Cache — don't cache authenticated API responses

Cache rule (or Configuration Rule):
- **Bypass cache** for the API — match `URI Path` not ending in a static asset
  (or simply: path starts with `/auth`, `/me`, `/employees`, `/ingest`, `/reports`,
  `/kpi`, `/leave`, `/liability`, `/attendance`, `/exact`, `/policy`, `/support`,
  `/alerts`, `/controls`, `/tenants`). The app already sends JSON with no-store
  intent; this makes the edge respect it.
- **Cache** only static assets: `*.js`, `*.css`, `/index.html`, `*.svg`, `*.ico`.
