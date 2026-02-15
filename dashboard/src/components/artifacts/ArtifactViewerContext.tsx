import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ArtifactViewerState {
  artifactId: string | null;
  context?: { entityType?: string; entityId?: string };
}

interface ArtifactViewerContextValue {
  state: ArtifactViewerState;
  open: (artifactId: string, context?: ArtifactViewerState['context']) => void;
  close: () => void;
}

const ArtifactViewerCtx = createContext<ArtifactViewerContextValue | null>(null);

export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ArtifactViewerState>({ artifactId: null });

  const open = useCallback(
    (artifactId: string, context?: ArtifactViewerState['context']) => {
      setState({ artifactId, context });
    },
    []
  );

  const close = useCallback(() => {
    setState({ artifactId: null });
  }, []);

  return (
    <ArtifactViewerCtx.Provider value={{ state, open, close }}>
      {children}
    </ArtifactViewerCtx.Provider>
  );
}

export function useArtifactViewer(): ArtifactViewerContextValue {
  const ctx = useContext(ArtifactViewerCtx);
  if (!ctx) {
    throw new Error('useArtifactViewer must be used within ArtifactViewerProvider');
  }
  return ctx;
}
