import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const defaultSentryDsn =
  'https://8c918638b4bd7bba5c0b54b52018feba@o4507108730077184.ingest.us.sentry.io/4511736557666304';

export default defineConfig(({ command }) => {
  const isBuild = command === 'build';

  return {
    plugins: [
      react(),
      sentryVitePlugin({
        org: 'knodible',
        project: 'orgx-clients',
        authToken: process.env.SENTRY_AUTH_TOKEN,
        disable: !process.env.SENTRY_AUTH_TOKEN,
        telemetry: false,
        silent: !process.env.CI,
        release: {
          name: `@useorgx/openclaw-plugin@${version}`,
          setCommits: { auto: true },
        },
        sourcemaps: { assets: './dist/**' },
      }),
    ],
    define: {
      __ORGX_PLUGIN_VERSION__: JSON.stringify(version),
      __ORGX_SENTRY_DSN__: JSON.stringify(
        process.env.ORGX_SENTRY_DSN ?? defaultSentryDsn,
      ),
    },
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
      sourcemap: Boolean(process.env.SENTRY_AUTH_TOKEN),
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
