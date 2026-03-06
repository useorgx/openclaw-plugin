import type { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/queryKeys';

export const LIVE_DATA_INVALIDATE_DEBOUNCE_MS = 750;

export interface MissionControlInvalidateInput {
  initiativeId?: string | null;
  projectId?: string | null;
  authToken?: string | null;
  embedMode?: boolean;
  queueQueryKey?: readonly unknown[];
  includeQueue?: boolean;
  includeGraph?: boolean;
  includeSlices?: boolean;
  includeAutoContinue?: boolean;
  includeLiveData?: boolean;
}

export async function invalidateMissionControlQueries(
  queryClient: QueryClient,
  input: MissionControlInvalidateInput
): Promise<void> {
  const {
    initiativeId = null,
    projectId = null,
    authToken = null,
    embedMode = false,
    queueQueryKey,
    includeQueue = true,
    includeGraph = true,
    includeSlices = true,
    includeAutoContinue = true,
    includeLiveData = true,
  } = input;

  const operations: Array<Promise<unknown>> = [];

  if (includeQueue) {
    if (queueQueryKey) {
      operations.push(queryClient.invalidateQueries({ queryKey: queueQueryKey }));
    } else {
      operations.push(queryClient.invalidateQueries({ queryKey: ['mission-control-next-up'] }));
    }
  }

  if (includeGraph) {
    operations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.missionControlGraph({ initiativeId, authToken, embedMode }),
      })
    );
  }

  if (includeSlices) {
    operations.push(queryClient.invalidateQueries({ queryKey: ['mission-control-slices'] }));
  }

  if (includeAutoContinue) {
    operations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.autoContinueStatus({ initiativeId, authToken, embedMode }),
      })
    );
  }

  if (includeLiveData) {
    operations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.liveData({ authToken, embedMode, projectId }),
      })
    );
    operations.push(queryClient.invalidateQueries({ queryKey: ['live-data'] }));
  }

  await Promise.all(operations);
}
