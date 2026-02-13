/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        lime: '#BFFF00',
        teal: '#14B8A6',
        cyan: '#0AD4C4',
        iris: '#7C7CFF',
        surface: {
          0: '#02040A',
          1: '#08090D',
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
