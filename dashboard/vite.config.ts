import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';

  return {
    plugins: [react()],
    base: '/orgx/live/',
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    esbuild: isBuild
      ? {
          drop: ['console', 'debugger'],
          legalComments: 'none',
        }
      : undefined,
    build: {
      outDir: 'dist',
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          // Hash-based filenames reduce reverse-engineering signal in built artifact names.
          entryFileNames: 'assets/[hash].js',
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash][extname]',
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            // Keep high-churn app code separate from low-churn vendor for better caching.
            if (id.includes('react-dom')) return 'react-vendor';
            if (id.includes('react')) return 'react-vendor';
            if (id.includes('@tanstack')) return 'tanstack';
            if (id.includes('framer-motion')) return 'motion';
            return 'vendor';
          },
        },
      },
    },
  };
});
