export const queryKeys = {
  liveData: (params: {
    authToken?: string | null;
    embedMode?: boolean;
    useMock?: boolean;
  }) =>
    [
      'live-data',
      {
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
        useMock: params.useMock ?? false,
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
  }) =>
    [
      'entities',
      {
        type: params.type,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
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
  nextUpQueue: (params: {
    initiativeId?: string | null;
    authToken?: string | null;
    embedMode?: boolean;
  }) =>
    [
      'mission-control-next-up',
      {
        initiativeId: params.initiativeId ?? null,
        authToken: params.authToken ?? null,
        embedMode: params.embedMode ?? false,
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
  liveInitiatives: (params?: { limit?: number }) =>
    [
      'live-initiatives',
      {
        limit: params?.limit ?? 300,
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
};
