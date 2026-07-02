import type { Config } from 'tailwindcss';

// SINGLE SOURCE OF TRUTH: Design's canonical styles.css (committed verbatim as
// src/styles/tokens.css once its F7 reconciliation is CONFIRMED — see
// src/styles/tokens.css header). Tailwind maps semantic utilities onto those
// custom properties; no colour, radius, or spacing literal lives here or in any
// component. Changing a token means changing tokens.css, nothing else.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: 'var(--color-brand)',
        'brand-contrast': 'var(--color-brand-contrast)',
        surface: 'var(--color-surface)',
        'surface-raised': 'var(--color-surface-raised)',
        ink: 'var(--color-ink)',
        'ink-muted': 'var(--color-ink-muted)',
        line: 'var(--color-line)',
        ok: 'var(--color-ok)',
        warn: 'var(--color-warn)',
        danger: 'var(--color-danger)',
        'rag-green': 'var(--color-rag-green)',
        'rag-amber': 'var(--color-rag-amber)',
        'rag-red': 'var(--color-rag-red)',
        'rag-grey': 'var(--color-rag-grey)',
        uat: 'var(--color-uat-banner)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
      },
      fontFamily: {
        sans: 'var(--font-sans)',
      },
      spacing: {
        gutter: 'var(--space-gutter)',
      },
    },
  },
  plugins: [],
} satisfies Config;
