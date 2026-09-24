import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@douyinfe/semi-ui/dist/css/semi.min.css': path.resolve(
        __dirname,
        'node_modules/@douyinfe/semi-ui/dist/css/semi.min.css'
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: loadEnv(mode, process.cwd(), '').VITE_API_PROXY_TARGET || 'http://localhost:5001',
        changeOrigin: true,
        xfwd: true,
      },
      '/ws': {
        target: (loadEnv(mode, process.cwd(), '').VITE_API_PROXY_TARGET || 'http://localhost:5001').replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
      },
      // 产品站（portal/site/）由 Flask 静态托管，dev 下代理到后端，行为与生产一致
      '/site': {
        target: loadEnv(mode, process.cwd(), '').VITE_API_PROXY_TARGET || 'http://localhost:5001',
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          // 常用 vendor 独立分包，便于浏览器长缓存；页面级依赖由动态 import 自动拆分
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'semi-ui': ['@douyinfe/semi-ui', '@douyinfe/semi-icons'],
        },
      },
    },
  },
}))
