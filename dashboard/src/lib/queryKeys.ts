export const queryKeys = {
  liveData: (params: {
    authToken?: string | null;
    embedMode?: boolean;
    useMock?: boolean;
    projectId?: string | null;
  }) =>
    [
      'live-data',
      {
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
        useMock: params.useMock ?? false,
        projectId: params.projectId ?? null,
      },
    ] as const,
  sessions: (params: {
    activeMinutes?: number;
    limit?: number;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'sessions',
      {
        activeMinutes: params.activeMinutes ?? null,
        limit: params.limit ?? null,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  initiativeDetails: (params: {
    initiativeId: string | null;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'initiative-details',
      {
        initiativeId: params.initiativeId,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  entities: (params: {
    type: string;
    authToken?: string | null;
    embedMode?: boolean;
    projectId?: string | null;
  }) =>
    [
      'entities',
      {
        type: params.type,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
        projectId: params.projectId ?? null,
      },
    ] as const,
  missionControlGraph: (params: {
    initiativeId: string | null;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'mission-control-graph',
      {
        initiativeId: params.initiativeId,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  missionControlSlices: (params: {
    workspaceId?: string | null;
    initiativeId?: string | null;
    level: 'initiative' | 'workstream' | 'milestone' | 'task';
    orderMode?: 'manual' | 'algorithmic' | null;
    includeCompleted?: boolean;
    search?: string;
    offset?: number;
    limit?: number;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'mission-control-slices',
      {
        workspaceId: params.workspaceId ?? null,
        initiativeId: params.initiativeId ?? null,
        level: params.level,
        orderMode: params.orderMode ?? null,
        includeCompleted: params.includeCompleted ?? false,
        search: params.search?.trim().toLowerCase() ?? '',
        offset: Math.max(0, params.offset ?? 0),
        limit: Math.max(1, params.limit ?? 24),
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  nextUpQueue: (params: {
    initiativeId?: string | null;
    authToken?: string | null;
    embedMode?: boolean;
    projectId?: string | null;
    snapshotVersion?: number | null;
  }) =>
    [
      'mission-control-next-up',
      {
        initiativeId: params.initiativeId ?? null,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
        projectId: params.projectId ?? null,
        snapshotVersion:
          typeof params.snapshotVersion === 'number' &&
          Number.isFinite(params.snapshotVersion)
            ? params.snapshotVersion
            : null,
      },
    ] as const,
  autoContinueStatus: (params: {
    initiativeId: string | null;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'auto-continue-status',
      {
        initiativeId: params.initiativeId,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  liveInitiatives: (params?: { limit?: number; projectId?: string | null }) =>
    [
      'live-initiatives',
      {
        limit: params?.limit ?? 300,
        projectId: params?.projectId ?? null,
      },
    ] as const,
  initiativeSearch: (params: { query: string; projectId?: string | null }) =>
    [
      'initiative-search',
      {
        query: params.query.trim().toLowerCase(),
        projectId: params.projectId ?? null,
      },
    ] as const,
  artifactsByEntity: (params: {
    entityType: string;
    entityId: string;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'artifacts-by-entity',
      {
        entityType: params.entityType,
        entityId: params.entityId,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  artifactDetail: (params: {
    artifactId: string;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'artifact-detail',
      {
        artifactId: params.artifactId,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
  triageQueue: (params: {
    workspaceId?: string | null;
    status?: string;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'triage-queue',
      {
        workspaceId: params.workspaceId ?? null,
        status: params.status ?? 'open',
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
      },
    ] as const,
};
