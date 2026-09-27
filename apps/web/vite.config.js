import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5175,
    proxy: {
      '/v1': {target:'http://localhost:5004',changeOrigin:true,xfwd:true},
      '/api': {
        target: 'http://localhost:5004',
        changeOrigin: true,
        xfwd: true,
      },
      '/ws': {
        target: 'ws://localhost:5004',
        ws: true,
        // Don't rewrite Host: the backend /ws/devtools handshake checks that Origin and Host are same-origin (changeOrigin would make Host 5001 and get rejected)
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          // Split common vendors into their own chunks for long-term browser caching; page-level dependencies are split automatically via dynamic import
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'radix-ui': ['radix-ui'],
          motion: ['motion'],
        },
      },
    },
  },
})
