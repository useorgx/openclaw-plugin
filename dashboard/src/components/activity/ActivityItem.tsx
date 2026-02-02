import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { colors } from '@/lib/tokens';
import type { ActivityItem as ActivityItemType, Artifact } from '@/types';

interface ActivityItemProps {
  item: ActivityItemType;
  onArtifactClick?: (artifact: Artifact) => void;
}

function ArtifactTypeIcon({ type }: { type: string }) {
  if (type === 'pull_request') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/50">
        <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" /><path d="M6 9v12" />
      </svg>
    );
  }
  if (type === 'email_draft') {
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/50">
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/50">
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

export function ActivityItemView({ item, onArtifactClick }: ActivityItemProps) {
  return (
    <div className="flex gap-2.5 py-3 border-b border-white/[0.04] last:border-b-0">
      <div className="flex-shrink-0 mt-0.5">
        <AgentAvatar name={item.agent} size="xs" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12px] text-white/70 leading-relaxed">
          <span className="font-medium text-white">{item.agent}</span>{' '}
          {item.title}
        </p>
        <span className="text-[9px] font-mono text-white/30 mt-0.5 block">
          {item.time}
        </span>
        {item.artifact && (
          <button
            onClick={() => onArtifactClick?.(item.artifact!)}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg transition-all hover:bg-white/[0.08] group"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.04)',
              border: `1px solid ${colors.cardBorder}`,
            }}
          >
            <ArtifactTypeIcon type={item.artifact.type} />
            <span className="text-[11px] text-white/60 group-hover:text-white/80">
              {item.artifact.label}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-white/30 group-hover:text-white/50 ml-1"
            >
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
