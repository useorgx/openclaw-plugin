import { Modal } from '@/components/shared/Modal';
import { colors } from '@/lib/tokens';
import type { Artifact } from '@/types';

interface ArtifactPreviewProps {
  artifact: Artifact | null;
  onClose: () => void;
}

function ArtifactIcon({ type }: { type: string }) {
  if (type === 'pull_request') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colors.lime} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v12" />
      </svg>
    );
  }
  if (type === 'email_draft') {
    return (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colors.lime} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={colors.lime} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" />
    </svg>
  );
}

const typeLabels: Record<string, string> = {
  pull_request: 'Pull Request',
  email_draft: 'Email Draft',
  document: 'Document',
  other: 'Artifact',
};

export function ArtifactPreview({ artifact, onClose }: ArtifactPreviewProps) {
  if (!artifact) return null;

  return (
    <Modal open={!!artifact} onClose={onClose}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
        <div className="flex items-center gap-3">
          <ArtifactIcon type={artifact.type} />
          <div>
            <h3 className="text-sm font-medium text-white">{artifact.label}</h3>
            <span className="text-[10px] text-white/40 uppercase tracking-wider">
              {typeLabels[artifact.type] ?? 'Artifact'}
              {artifact.agent && ` · ${artifact.agent}`}
              {artifact.time && ` · ${artifact.time}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {artifact.url && (
            <a
              href={artifact.url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-2 rounded-lg hover:bg-white/[0.06] text-white/50 hover:text-white transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" /><path d="M10 14 21 3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </a>
          )}
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/[0.06] text-white/50 hover:text-white transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>
      <div className="p-6 overflow-y-auto max-h-[60vh]">
        {artifact.content ? (
          <pre className="whitespace-pre-wrap text-[13px] text-white/80 leading-relaxed font-sans">
            {artifact.content}
          </pre>
        ) : (
          <div className="text-center py-12 text-white/40">
            <svg className="mx-auto mb-3 opacity-50" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            </svg>
            <p className="text-sm">No preview available</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
