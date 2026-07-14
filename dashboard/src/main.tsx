import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { initTelemetry } from './lib/telemetry';
import { initDashboardSentry, Sentry } from './lib/sentry';
import './index.css';

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    // Recover from stale chunk graphs after plugin/dashboard upgrades.
    event.preventDefault();
    window.location.reload();
  });
}

initDashboardSentry();
initTelemetry();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      // Avoid "focus refetch" flicker for the live dashboard.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-[#080808] px-4 text-white">
          <div className="w-full max-w-md rounded-xl border border-white/[0.06] bg-[#0f0f0f] p-6">
            <h1 className="text-lg font-semibold">OrgX Live hit a snag</h1>
            <p className="mt-2 text-sm text-white/60">
              Reload the dashboard. The failure was reported without workspace content or credentials.
            </p>
          </div>
        </main>
      }
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
