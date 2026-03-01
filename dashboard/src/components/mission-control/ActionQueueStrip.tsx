import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { sanitizeDisplayText } from '@/lib/humanize';
import type { NextUpQueueItem } from '@/types';

interface ActionQueueStripProps {
  items: NextUpQueueItem[];
  onOpenItem?: (item: NextUpQueueItem) => void;
  className?: string;
}

function statusDotColor(state: string): string {
  if (state === 'blocked') return '#FF6B88';
  if (state === 'running') return '#BFFF00';
  return '#F5B700';
}

export function ActionQueueStrip({ items, onOpenItem, className }: ActionQueueStripProps) {
  if (items.length === 0) return null;

  // Sort: blocked → running → queued
  const sorted = [...items].sort((a, b) => {
    const order = { blocked: 0, running: 1, queued: 2, idle: 3, completed: 4 };
    return (order[a.queueState] ?? 3) - (order[b.queueState] ?? 3);
  });

  return (
    <div className={`flex gap-2 overflow-x-auto pb-1 ${className ?? ''}`}>
      {sorted.slice(0, 12).map((item) => {
        const title = sanitizeDisplayText(item.workstreamTitle);
        return (
          <button
            key={`${item.initiativeId}:${item.workstreamId}`}
            type="button"
            onClick={() => onOpenItem?.(item)}
            className="chip chip-avatar flex items-center gap-1.5 flex-shrink-0 hover:bg-white/[0.08] transition-colors"
            title={title}
          >
            <AgentAvatar name={item.runnerAgentName} hint={item.runnerAgentName} size="xs" />
            <span className="max-w-[120px] truncate text-[11px]">{title}</span>
            <span
              className="h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: statusDotColor(item.queueState) }}
            />
          </button>
        );
      })}
    </div>
  );
}
