/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Blueprint-* tokens — architectural navy palette
        'blueprint-bg':     '#060f1e',
        'blueprint-card':   '#0a1929',
        'blueprint-border': '#1a3d5c',
        'blueprint-muted':  '#4d7a96',
        'blueprint-blue':   '#4da6ff',
        'blueprint-amber':  '#f59e0b',
        'blueprint-red':    '#ff5252',
        'blueprint-green':  '#00c9a7',
        'blueprint-purple': '#9d7aff',
        'blueprint-orange': '#ff8c42',

        // bp-* design system tokens
        'bp-base':       '#060f1e',
        'bp-surface':    '#0a1929',
        'bp-surface-2':  '#0d2138',
        'bp-surface-3':  '#1a3d5c',
        'bp-blue':       '#4da6ff',
        'bp-blue-bright':'#7cc3ff',
        'bp-blue-dim':   '#1a6fc4',
        'bp-cyan':       '#4da6ff',
        'bp-green':      '#00c9a7',
        'bp-amber':      '#f59e0b',
        'bp-red':        '#ff5252',
        'bp-orange':     '#ff8c42',
        'bp-purple':     '#9d7aff',
        'bp-muted':      '#4d7a96',
        'bp-text':       '#c9dff2',
        'bp-text-2':     '#7aafc9',
        'bp-text-3':     '#4d7a96',
        'bp-text-blue':  '#4da6ff',
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
