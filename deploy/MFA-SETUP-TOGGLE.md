# Console MFA — setup-phase toggle (REVERSIBLE, time-boxed)

**Decision (Kira, 2026-07-07):** for the setup phase, HIDE the console-login MFA
field AND DISABLE MFA enforcement — **together**, via ONE reversible flag.

## ‼️ UAT-WEEK REVERSAL — DO NOT FORGET

For UAT week the MFA field must be **VISIBLE** and enforcement **ON**, together.
Flip the single control back:

- **Preferred:** set `MFA_SETUP_PHASE: '0'` in
  `.github/workflows/deploy-uat.yml` and refire the deploy.
- **On the box (immediate):**
  `hcmos-run bash -c "sudo -u postgres psql -d hcmos -c \"UPDATE config SET value='1' WHERE key='auth.mfa.required'\""`

A **half-flip is impossible** — the field's visibility and enforcement read the
SAME key, so they can only move together. A login with the field back but
enforcement off (or enforced but no field) cannot occur.

## The one flag

`auth.mfa.required` (registry config, per-tenant; DEFAULT_CONFIG default `'1'`):

| value | login MFA field | server enforcement | phase |
|-------|-----------------|--------------------|-------|
| `'0'` | HIDDEN | NOT enforced | **setup (now)** |
| `'1'` | VISIBLE | enforced (AUTH-01 three-factor) | **UAT week + permanent** |

- **Field visibility:** the login UI calls `GET /auth/config` (public,
  `auth.publicAuthConfig` → `auth_public_config()` SECURITY DEFINER, reads the
  primary tenant's flag) and renders the MFA field only when `mfaRequired`.
- **Enforcement:** `consoleLogin` already reads `auth.mfa.required` per the
  user's tenant. Unchanged.
- The deploy's setup step sets the flag for **every tenant** on the box, so the
  pre-auth field-visibility read can never disagree with per-tenant enforcement.

## Unchanged invariants (never touched by this toggle)

- Console login model stays **email + password + MFA**. PIN is **never** on
  console — PIN is ESS-only (field login, device + PIN). The toggle only
  hides/shows the MFA field and flips its enforcement.
- No other login visual changes.

## Visual-parity gate — why nothing red-fails, nothing to restore

The field's visibility is a **runtime registry flag**, not a build change. CI
seeds the DEFAULT (`auth.mfa.required='1'`), so the CI login render shows the
MFA field and **matches the locked baselines** — the visual gate stays GREEN
with no baseline edit, no exemption, no re-lock. The field-hidden login exists
only on the box as a deliberate config state. When UAT week flips the flag back
to `'1'`, the box render returns to the with-MFA baseline automatically. There
is therefore no baseline to archive or restore.

## Test credentials / activation

- Temp password per account, recorded ONLY in `/root/uat-credentials.txt` (600)
  on the box (never repo/CI log). Rotate on first real use (operational; not
  system-enforced — flag if hard force-change is wanted).
- The deploy prints an **activation summary**: `X of N provisioned accounts
  authenticate on email+password` (MFA off in setup). Super admins (Kira's
  interactive step) and pending-name roster are not yet in the file — target 15.

## Deferred, bundled with the UAT-week reversal: the privileged-role MFA floor

**bughunt-B #4 (Kira decision, 2026-07-12):** when `MFA_SETUP_PHASE` flips to
`'0'` for UAT week, land — in the SAME change — a **privileged-role MFA floor**:
R12 and super-admin accounts are ALWAYS MFA-enforced, regardless of
`auth.mfa.required`. From that point no toggle (present or future) can un-MFA a
privileged account. It is deliberately NOT landed during the setup phase: it
would lock out the R12 admin (Rajesh), who has no TOTP enrolled while the setup
toggle is on. One bundle: reversal + floor, tested together.
