/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Blueprint-* tokens — rich blueprint navy palette
        'blueprint-bg':     '#0f2540',
        'blueprint-card':   '#162d4e',
        'blueprint-border': '#2c4f7a',
        'blueprint-muted':  '#88aecf',
        'blueprint-blue':   '#5ab4ff',
        'blueprint-amber':  '#fbb040',
        'blueprint-red':    '#ff6b6b',
        'blueprint-green':  '#00ddb5',
        'blueprint-purple': '#b090ff',
        'blueprint-orange': '#ff9f5a',

        // bp-* design system tokens
        'bp-base':       '#0f2540',
        'bp-surface':    '#162d4e',
        'bp-surface-2':  '#1e3a60',
        'bp-surface-3':  '#2c4f7a',
        'bp-blue':       '#5ab4ff',
        'bp-blue-bright':'#90caff',
        'bp-blue-dim':   '#2a7fd4',
        'bp-cyan':       '#5ab4ff',
        'bp-green':      '#00ddb5',
        'bp-amber':      '#fbb040',
        'bp-red':        '#ff6b6b',
        'bp-orange':     '#ff9f5a',
        'bp-purple':     '#b090ff',
        'bp-muted':      '#88aecf',
        'bp-text':       '#f0f8ff',
        'bp-text-2':     '#b8d8f0',
        'bp-text-3':     '#88aecf',
        'bp-text-blue':  '#5ab4ff',
      },
      fontFamily: {
        mono:    ['"DM Mono"', '"JetBrains Mono"', 'Consolas', 'monospace'],
        display: ['Syne', 'system-ui', 'sans-serif'],
        sans:    ['Syne', 'system-ui', 'sans-serif'],
      },
      keyframes: {
        'bp-pulse': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%':       { opacity: '0.5', transform: 'scale(0.85)' },
        },
        'bp-enter': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'bp-shimmer': {
          '0%':   { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'bp-spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to:   { transform: 'rotate(360deg)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%':       { opacity: '0.3' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
      animation: {
        'bp-pulse':       'bp-pulse 2s ease-in-out infinite',
        'bp-enter':       'bp-enter 300ms ease-out forwards',
        'bp-shimmer':     'bp-shimmer 1.5s infinite',
        'bp-spin-slow':   'bp-spin-slow 3s linear infinite',
        'pulse-dot':      'pulse-dot 2s ease-in-out infinite',
        'slide-in-right': 'slide-in-right 0.2s ease-out',
        'fade-in':        'fade-in 0.15s ease-out',
        shimmer:          'shimmer 1.5s linear infinite',
      },
    },
  },
  plugins: [],
}
