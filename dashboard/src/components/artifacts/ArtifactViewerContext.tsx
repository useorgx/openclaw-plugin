import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ArtifactViewerState {
  artifactId: string | null;
  context?: { entityType?: string; entityId?: string };
  /** Raw content blob for syntax-highlighted preview */
  contentBlob: string | null;
  /** Auto-detected language of the content (json, yaml, markdown, typescript) */
  detectedLanguage: string | null;
  /** Brand color of the producing agent, used to tint syntax keywords */
  agentColor: string | null;
}

interface ArtifactViewerContextValue {
  state: ArtifactViewerState;
  open: (
    artifactId: string,
    context?: ArtifactViewerState['context'],
    extra?: {
      contentBlob?: string | null;
      detectedLanguage?: string | null;
      agentColor?: string | null;
    }
  ) => void;
  close: () => void;
  /** Update content/language/agentColor after the modal has been opened (e.g. after fetch) */
  setContentMeta: (meta: {
    contentBlob?: string | null;
    detectedLanguage?: string | null;
    agentColor?: string | null;
  }) => void;
}

const ArtifactViewerCtx = createContext<ArtifactViewerContextValue | null>(null);

const INITIAL_STATE: ArtifactViewerState = {
  artifactId: null,
  contentBlob: null,
  detectedLanguage: null,
  agentColor: null,
};

export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ArtifactViewerState>(INITIAL_STATE);

  const open = useCallback(
    (
      artifactId: string,
      context?: ArtifactViewerState['context'],
      extra?: {
        contentBlob?: string | null;
        detectedLanguage?: string | null;
        agentColor?: string | null;
      }
    ) => {
      setState({
        artifactId,
        context,
        contentBlob: extra?.contentBlob ?? null,
        detectedLanguage: extra?.detectedLanguage ?? null,
        agentColor: extra?.agentColor ?? null,
      });
    },
    []
  );

  const close = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const setContentMeta = useCallback(
    (meta: {
      contentBlob?: string | null;
      detectedLanguage?: string | null;
      agentColor?: string | null;
    }) => {
      setState((prev) => ({
        ...prev,
        contentBlob: meta.contentBlob !== undefined ? meta.contentBlob : prev.contentBlob,
        detectedLanguage:
          meta.detectedLanguage !== undefined ? meta.detectedLanguage : prev.detectedLanguage,
        agentColor: meta.agentColor !== undefined ? meta.agentColor : prev.agentColor,
      }));
    },
    []
  );

  return (
    <ArtifactViewerCtx.Provider value={{ state, open, close, setContentMeta }}>
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
