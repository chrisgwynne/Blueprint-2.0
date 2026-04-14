import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api':  'http://localhost:4000',
      '/docs': 'http://localhost:4000',
    }
  },
  build: {
    outDir: 'dist',
    // Pages are lazy-loaded so individual chunks will be well under 500 kB.
    // Raise the warning threshold to avoid noise from the intentionally large
    // vendor bundles (recharts, tiptap) that are loaded on-demand.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Function form handles transitive deps that the static map misses.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('recharts') || id.includes('d3-') || id.includes('d3/'))
            return 'charts';
          if (id.includes('@tiptap') || id.includes('prosemirror'))
            return 'editor';
          if (id.includes('react-dom') || id.includes('react-router') ||
              id.includes('react/') || id.includes('scheduler/'))
            return 'vendor';
          if (id.includes('lucide-react') || id.includes('date-fns') ||
              id.includes('zustand') || id.includes('clsx'))
            return 'ui';
          // Everything else (js-yaml, marked, highlight.js, etc.) lands in
          // vendor alongside react — avoids the circular lib↔vendor warning.
          return 'vendor';
        },
      },
    },
  },
})
