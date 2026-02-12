import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import posthog from 'posthog-js';
import { App } from './App';
import './index.css';

// Keep PostHog behavior stable across upgrades. Types can lag behind SDK config.
posthog.init(
  'phc_s4KPgkYEFZgvkMYw4zXG41H5FN6haVwbEWPYHfNjxOc',
  {
    api_host: 'https://us.i.posthog.com',
    defaults: '2026-01-30',
    person_profiles: 'identified_only',
  } as any,
);

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
