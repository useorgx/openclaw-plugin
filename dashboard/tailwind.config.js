/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        lime: '#c8e64a',
        teal: '#7dd3c0',
        iris: '#818cf8',
        surface: {
          0: '#080808',
          1: '#0f0f0f',
          2: '#1a1a1f',
          3: '#232329',
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'system-ui',
          'SF Pro Text',
          'Inter',
          'sans-serif',
        ],
        mono: ['SF Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
