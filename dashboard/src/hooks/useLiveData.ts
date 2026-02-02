import { useState, useEffect, useCallback, useRef } from 'react';
import type { LiveData } from '@/types';
import { createMockData } from '@/data/mockData';

interface UseLiveDataOptions {
  pollInterval?: number;
  useMock?: boolean;
}

export function useLiveData(options: UseLiveDataOptions = {}) {
  const { pollInterval = 5000, useMock = true } = options;
  const [data, setData] = useState<LiveData>(createMockData('normal'));
  const [isLoading, setIsLoading] = useState(!useMock);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval>>();

  const fetchData = useCallback(async () => {
    if (useMock) {
      setData(createMockData('normal'));
      setIsLoading(false);
      return;
    }

    try {
      const [statusRes, agentsRes, activityRes, initiativesRes] =
        await Promise.all([
          fetch('/orgx/api/status'),
          fetch('/orgx/api/agents'),
          fetch('/orgx/api/activity'),
          fetch('/orgx/api/initiatives'),
        ]);

      if (!statusRes.ok) throw new Error('Failed to fetch status');

      const status = await statusRes.json();
      const agents = agentsRes.ok ? await agentsRes.json() : [];
      const activities = activityRes.ok ? await activityRes.json() : [];
      const initiatives = initiativesRes.ok
        ? await initiativesRes.json()
        : [];

      setData({
        connection: 'connected',
        lastActivity: status.lastActivity ?? null,
        agents: agents.agents ?? [],
        activities: activities.activities ?? [],
        initiatives: initiatives.initiatives ?? [],
        pendingDecisions: status.pendingDecisions ?? [],
      });
      setError(null);
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setData((prev) => ({ ...prev, connection: 'reconnecting' }));
    }
  }, [useMock]);

  useEffect(() => {
    fetchData();
    intervalRef.current = setInterval(fetchData, pollInterval);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchData, pollInterval]);

  return { data, isLoading, error, refetch: fetchData };
}
