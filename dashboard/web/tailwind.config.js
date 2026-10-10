/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'),
        surface: v('surface'),
        surface2: v('surface-2'),
        border: v('border'),
        text: v('text'),
        muted: v('muted'),
        go: v('go'),
        py: v('py'),
        gofg: v('go-fg'),
        pyfg: v('py-fg'),
        better: v('better'),
        worse: v('worse'),
        warn: v('warn'),
        model: v('model'),
        tool: v('tool'),
        session: v('session'),
        overhead: v('overhead'),
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { card: '12px' },
      screens: { pane: '900px' },
    },
  },
  plugins: [],
};
