// Visual-parity matrix (AC-UNI-01/03 core set). Drives the BUILT app over the
// seeded certified backend and screenshots each screen per theme × surface —
// delivery-order core first (Light + Dark × Desktop + Mobile, per F6's
// recommendation; Glass/Reduced/Tablet/Kiosk extend the same loops later).
// Credentials/TOTP come from the certified test fixtures — the same seed the
// functional suite pins, so what Design accepts is what the gates actually
// serve (e.g. the R03 pay refusals really are 403s, absent really is absent).
import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';

// The fixtures + TOTP helper are CommonJS from the certified backend; the
// frontend package is ESM ("type": "module"), so bridge with createRequire.
const require = createRequire(import.meta.url);
const F = require('../../test/fixtures');
const C = require('../../src/crypto');

const THEMES = ['light', 'dark'] as const;
const SURFACES = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 760 } } as const;

async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/login');
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  await page.fill('input[name="mfa"]', C.currentTotp(F.MFA_SECRET));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('/login'));
}

async function shoot(page: Page, name: string, theme: string, surface: string) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(150); // settle transitions (F5: 120–150ms feedback)
  await expect(page).toHaveScreenshot(`${theme}-${surface}/${name}.png`, { fullPage: false });
}

for (const theme of THEMES) {
  for (const [surface, viewport] of Object.entries(SURFACES)) {
    test.describe(`${theme} × ${surface}`, () => {
      test.use({ viewport });

      test.beforeEach(async ({ page }) => {
        await page.addInitScript((th) => localStorage.setItem('hcmos.theme', th as string), theme);
      });

      test('C1 login — empty + error (no factor revealed)', async ({ page }) => {
        await page.goto('/login');
        await shoot(page, 'c1-login-empty', theme, surface);
        await page.fill('input[name="email"]', 'nobody@a.example');
        await page.fill('input[name="password"]', 'wrong-password');
        await page.fill('input[name="mfa"]', '000000');
        await page.click('button[type="submit"]');
        await page.getByRole('alert').waitFor();
        await shoot(page, 'c1-login-error', theme, surface);
      });

      // Console track as R11 HR Director (central: directory, controls, alerts).
      test('console — R11 populated screens', async ({ page }) => {
        test.skip(surface === 'mobile', 'console is the desktop track; ESS covers mobile');
        test.setTimeout(180_000); // ten screenshots + a live controls run share this budget
        await login(page, F.USERS.DIRECTOR_A);
        await shoot(page, 'c2-overview', theme, surface);
        await page.goto('/directory');
        await page.waitForSelector('table.tbl tbody tr');
        await shoot(page, 'c4-directory', theme, surface);
        await page.click('table.tbl tbody tr'); // first row → C5 drawer
        await page.waitForSelector('.drawer-panel .prof-name');
        await shoot(page, 'c5-profile-drawer', theme, surface);
        await page.goto('/scorecard');
        await shoot(page, 'c3-scorecard', theme, surface);
        await page.goto('/liability');
        await shoot(page, 'c16-liability-empty', theme, surface);
        await page.goto('/controls');
        // The run is live (audit-chain verification over the seed) — wait for ANY
        // terminal state, generously; the screenshot then shows whichever it is.
        await page.waitForSelector(
          '[data-state="all-clear"], [data-state="populated"], [data-state="empty"], [data-state="error"], [data-state="no-permission"]',
          { timeout: 90_000 });
        await shoot(page, 'c20-controls', theme, surface);
        await page.goto('/alerts');
        await shoot(page, 'c20b-alerts', theme, surface);
        await page.goto('/policy');
        await shoot(page, 'e7-policy', theme, surface);
        await page.goto('/support');
        await shoot(page, 'e12-support', theme, surface);
        await page.goto('/tenant');
        await shoot(page, 'c21-tenant-noperm-or-step1', theme, surface);
      });

      // Confidentiality-conditional: R03 (site-scoped HR) is refused the
      // financial register — the designed no-permission state, server-decided.
      test('C16 liability — R03 refused (no-permission net)', async ({ page }) => {
        test.skip(surface === 'mobile', 'console track');
        await login(page, F.USERS.HR_A);
        await page.goto('/liability');
        await page.fill('input[name="batch"]', '00000000-0000-0000-0000-000000000000');
        await page.click('button[type="submit"]');
        await page.waitForSelector('[data-state="no-permission"], [data-state="error"]');
        await shoot(page, 'c16-liability-r03', theme, surface);
      });

      // ESS track as R13 field operator (mobile-first).
      test('ESS — R13 home / leave / kpis', async ({ page }) => {
        test.skip(surface === 'desktop', 'ESS is the mobile track');
        await login(page, F.USERS.FIELD_A);
        await page.waitForURL((u) => u.pathname.startsWith('/ess'));
        await shoot(page, 'e2-ess-home', theme, surface);
        await page.goto('/ess/leave');
        await page.waitForSelector('.tiles');
        await shoot(page, 'e4-apply-leave', theme, surface);
        await page.goto('/ess/kpis');
        await shoot(page, 'e8-my-kpis', theme, surface);
      });
    });
  }
}
