import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { initTelemetry } from './lib/telemetry';
import './index.css';

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event) => {
    // Recover from stale chunk graphs after plugin/dashboard upgrades.
    event.preventDefault();
    window.location.reload();
  });
}

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
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
