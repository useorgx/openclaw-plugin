import { useQuery } from '@tanstack/react-query';
import { buildOrgxHeaders } from '@/lib/http';

export function usePluginVersion() {
  return useQuery<string | null>({
    queryKey: ['plugin-version'],
    queryFn: async () => {
      const response = await fetch('/orgx/api/health', {
        headers: buildOrgxHeaders({}),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return (data?.plugin?.version as string) ?? null;
    },
    staleTime: Infinity,
  });
}
