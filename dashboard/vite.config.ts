import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';

  return {
    plugins: [react()],
    base: '/orgx/live/',
    server: isBuild
      ? undefined
      : {
          proxy: {
            '/orgx/api': {
              target: 'http://localhost:18789',
              changeOrigin: true,
            },
          },
        },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, '../src/contracts'),
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
      // Keep warning signal meaningful for this dashboard's intentional vendor profile.
      chunkSizeWarningLimit: 700,
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        output: {
          // Hash-based filenames reduce reverse-engineering signal in built artifact names.
          entryFileNames: 'assets/[hash].js',
          chunkFileNames: 'assets/[hash].js',
          assetFileNames: 'assets/[hash][extname]',
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;
            const normalizedId = id.replaceAll('\\', '/');
            // Keep stable heavy deps split without forcing a catch-all vendor chunk.
            if (
              normalizedId.includes('/node_modules/@ai-sdk/') ||
              normalizedId.includes('/node_modules/ai/')
            ) {
              return 'ai-sdk';
            }
            if (normalizedId.includes('/node_modules/date-fns/')) return 'date-fns';
            if (normalizedId.includes('/node_modules/react-datepicker/')) return 'datepicker';
            if (normalizedId.includes('/node_modules/posthog-js/')) return 'telemetry';
            if (
              normalizedId.includes('/node_modules/react-markdown/') ||
              normalizedId.includes('/node_modules/remark-gfm/')
            ) {
              return 'markdown';
            }
            if (
              normalizedId.includes('/node_modules/react-dom/') ||
              normalizedId.includes('/node_modules/react/') ||
              normalizedId.includes('/node_modules/scheduler/')
            ) {
              return 'react-core';
            }
            if (normalizedId.includes('/node_modules/@tanstack/')) return 'tanstack';
            if (normalizedId.includes('/node_modules/framer-motion/')) return 'motion';
            return undefined;
          },
        },
      },
    },
  };
});
