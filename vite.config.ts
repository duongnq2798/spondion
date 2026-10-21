import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import { sites } from './scripts/vite/sites-vite-plugin'

export default defineConfig(async () => {
 const localDemo = process.env.VITE_ENABLE_LOCAL_DEMO === 'true';
 const { cloudflare } = await import('@cloudflare/vite-plugin');
 return {
  plugins: [react(), nodePolyfills(), ...(!localDemo ? [sites(), cloudflare({ viteEnvironment: { name: 'server' }, remoteBindings: false, inspectorPort: false })] : [])],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      '@tanstack/react-query',
      'wagmi',
      'wagmi/chains',
      'wagmi/connectors',
      'viem',
      'viem/chains',
      'connectkit',
      'framer-motion',
      'lucide-react',
      'sonner',
      'clsx',
      'tailwind-merge',
      'vite-plugin-node-polyfills/shims/buffer',
      'vite-plugin-node-polyfills/shims/global',
      'vite-plugin-node-polyfills/shims/process',
    ],
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    proxy: localDemo ? {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    } : undefined,
  },
 };
})
