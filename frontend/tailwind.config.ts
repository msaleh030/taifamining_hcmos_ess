import type { Config } from 'tailwindcss';

// SINGLE SOURCE OF TRUTH: src/styles/hcmos.css — the canonical styles.css from
// design/HCMOS-Design-Spec.html (+ the landed F7 promotions). Tailwind here is
// layout glue only; these mappings expose the canonical custom properties so
// no colour, radius, or font literal ever appears in a component. Screens are
// styled by the canonical class vocabulary (.card, .kpi, .tbl, .btn, …) that
// the spec's redlines name.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: { preflight: false }, // the canonical sheet owns resets
  theme: {
    extend: {
      colors: {
        green: 'var(--green)',
        'green-d': 'var(--green-d)',
        blue: 'var(--blue)',
        yellow: 'var(--yellow)',
        red: 'var(--red)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        ink: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        line: 'var(--border)',
        'line-2': 'var(--border-2)',
      },
      borderRadius: {
        r: 'var(--r)',
        'r-sm': 'var(--r-sm)',
      },
      fontFamily: {
        sans: 'var(--font)',
        mono: 'var(--mono)',
      },
      spacing: {
        pad: 'var(--pad)',
      },
    },
  },
  plugins: [],
} satisfies Config;
