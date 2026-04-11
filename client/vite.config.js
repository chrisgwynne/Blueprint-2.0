import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000'
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor:  ['react', 'react-dom', 'react-router-dom'],
          charts:  ['recharts'],
          editor:  ['@tiptap/react', '@tiptap/starter-kit'],
          ui:      ['zustand', 'lucide-react', 'clsx', 'date-fns'],
        },
      },
    },
  },
})
