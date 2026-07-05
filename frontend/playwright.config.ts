import { defineConfig } from '@playwright/test';

// Visual-parity harness (the executable half of the parity bar). Runs against
// the REAL stack: the pure-Node server on :3000 serving frontend/dist over the
// seeded certified backend — no mocks, the gates answer live. Baselines live
// in ../design/app-baselines (Playwright snapshotPath): until Design accepts a
// screen's candidate, run `npm run visual:update` to (re)generate candidates;
// once committed, `npm run visual` enforces pixel parity in CI.
export default defineConfig({
  testDir: './visual',
  timeout: 30_000,
  retries: 1,
  workers: 1, // one browser, deterministic order — screenshots share seed data
  reporter: [['list']],
  snapshotPathTemplate: '../design/app-baselines/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001, // pixel-true bar; fonts are self-hosted so text is stable
      animations: 'disabled',
    },
  },
  use: {
    baseURL: process.env.VISUAL_BASE_URL || 'http://127.0.0.1:3000',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  },
});
