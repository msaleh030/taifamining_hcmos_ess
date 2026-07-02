import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The frontend is a same-origin client of the HCMOS API: the static build is
// served behind Cloudflare with the API on the same host, so fetches use bare
// paths (/auth/console, /employees, …). In dev, proxy those prefixes to the
// pure-Node server on :3000.
const API_PREFIXES = [
  '/auth', '/me', '/employees', '/field-change', '/leave', '/liability',
  '/kpi', '/attendance', '/exact', '/alerts', '/support', '/policy',
  '/controls', '/tenants', '/reports', '/ingest', '/health',
];

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'HCMOS / ESS',
        short_name: 'HCMOS',
        description: 'Taifa Mining HCMOS console and Employee Self-Service',
        display: 'standalone',
        // Theme/background colours come from the design tokens once the
        // canonical styles.css lands; neutral placeholders until then.
        theme_color: '#12324f',
        background_color: '#f4f6f9',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Static assets only. The API is NEVER cached: stale confidential data
        // (pay, medical) must not persist in a shared cache, and the backend's
        // gating decisions must always be live. Offline clock-in resilience is
        // handled by the explicit IndexedDB punch queue (src/lib/offline.ts),
        // not by caching API responses.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallbackDenylist: API_PREFIXES.map((p) => new RegExp(`^${p}`)),
        runtimeCaching: [],
      },
    }),
  ],
  server: {
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, { target: 'http://localhost:3000', changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: true },
});
