import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// OrgX design kit preset (vendored by scripts/sync-ui-kit.mjs): ox-*, agent-*,
// iris and the ox radii/motion, all resolving to the --ox-* variables.
const oxPreset = require('./vendor/orgx-ui-kit/tailwind-preset.cjs');

/**
 * Kit color from its rgb triplet variable so opacity modifiers (bg-teal/10) keep working.
 * The kit's --*-rgb values are comma-separated ("0,201,167"), which is only valid in the
 * legacy rgba(r, g, b, a) form, so use that rather than rgb(... / a).
 */
const ox = (name) => `rgba(var(--ox-${name}-rgb), <alpha-value>)`;
const agent = (key) => `rgba(var(--agent-${key}-rgb), <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  presets: [oxPreset],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // The dashboard's historical color names, resolved to the kit's tokens.
      // cyan and the elevated surfaces have no kit token.
      colors: {
        lime: ox('lime'),
        teal: ox('teal'),
        cyan: '#0AD4C4',
        'orgx-amber': ox('warning'),
        'orgx-red': ox('danger'),
        // Re-declared from the kit preset: kit 0.2.0-alpha.0 writes these as
        // rgb(var(--x-rgb) / a), which is invalid with its comma-separated triplets.
        iris: { DEFAULT: ox('iris') },
        ox: {
          teal: ox('teal'),
          warning: ox('warning'),
          danger: ox('danger'),
          lime: ox('lime'),
          iris: ox('iris'),
          mute: ox('mute'),
          primary: ox('primary'),
        },
        agent: {
          pace: agent('pace'),
          eli: agent('eli'),
          mark: agent('mark'),
          sage: agent('sage'),
          orion: agent('orion'),
          dana: agent('dana'),
          xandy: agent('xandy'),
        },
        surface: {
          0: 'var(--ox-bg)',
          1: 'var(--ox-panel-solid)',
          2: '#0C0E14',
          3: '#10141E',
        },
      },
      textColor: {
        bright: 'var(--orgx-text-bright)',
        primary: 'var(--orgx-text-primary)',
        secondary: 'var(--orgx-text-secondary)',
        muted: 'var(--orgx-text-muted)',
        faint: 'var(--orgx-text-faint)',
      },
      borderColor: {
        hairline: 'var(--orgx-border-hairline)',
        subtle: 'var(--orgx-border-subtle)',
        DEFAULT: 'var(--orgx-border)',
        strong: 'var(--orgx-border-strong)',
      },
      fontSize: {
        micro: ['10px', { lineHeight: '14px' }],
        caption: ['11px', { lineHeight: '16px' }],
        body: ['13px', { lineHeight: '20px' }],
        heading: ['15px', { lineHeight: '22px' }],
        title: ['20px', { lineHeight: '28px' }],
        display: ['28px', { lineHeight: '34px', letterSpacing: '-0.02em' }],
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        card: '0 12px 34px rgba(0,0,0,0.35)',
      },
    },
  },
  plugins: [],
};
