import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: '/orgx/live/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          // Keep high-churn app code separate from low-churn vendor for better caching,
          // and reduce the "single huge chunk" parse cost.
          if (id.includes('react-dom')) return 'react-vendor';
          if (id.includes('react')) return 'react-vendor';
          if (id.includes('@tanstack')) return 'tanstack';
          if (id.includes('framer-motion')) return 'motion';
          return 'vendor';
        },
      },
    },
  },
});
