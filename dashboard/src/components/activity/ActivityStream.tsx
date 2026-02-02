import { useState } from 'react';
import { cn } from '@/lib/utils';
import { colors } from '@/lib/tokens';
import type { ActivityItem, Artifact } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { SearchInput } from '@/components/shared/SearchInput';
import { ActivityItemView } from './ActivityItem';

interface ActivityStreamProps {
  activities: ActivityItem[];
  selectedAgentId: string | null;
  onClearAgentFilter: () => void;
  onArtifactClick: (artifact: Artifact) => void;
}

export function ActivityStream({
  activities,
  selectedAgentId,
  onClearAgentFilter,
  onArtifactClick,
}: ActivityStreamProps) {
  const [filter, setFilter] = useState<'all' | 'artifacts' | 'decisions'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 10;

  const filtered = activities.filter((a) => {
    if (selectedAgentId && a.agentId !== selectedAgentId) return false;
    if (search && !a.title.toLowerCase().includes(search.toLowerCase()))
      return false;
    if (filter === 'all') return true;
    if (filter === 'artifacts') return a.type === 'artifact';
    if (filter === 'decisions') return ['decision', 'blocked'].includes(a.type);
    return true;
  });

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

  if (activities.length === 0) {
    return (
      <PremiumCard className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-white/[0.04]">
          <span className="text-[13px] font-medium text-white">Activity</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <svg className="mx-auto mb-2 text-white/20" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <p className="text-[11px] text-white/40">Waiting for activity</p>
          </div>
        </div>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className="flex-1 flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-white">Activity</span>
            <span className="relative flex h-1.5 w-1.5">
              <span
                className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                style={{ backgroundColor: colors.lime }}
              />
              <span
                className="relative inline-flex rounded-full h-1.5 w-1.5"
                style={{ backgroundColor: colors.lime }}
              />
            </span>
            {selectedAgentId && (
              <button
                onClick={onClearAgentFilter}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] bg-white/[0.06] text-white/50 hover:bg-white/[0.1]"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
                Filter
              </button>
            )}
          </div>

          <div
            className="flex p-0.5 rounded-lg"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
          >
            {(['all', 'artifacts', 'decisions'] as const).map((f) => (
              <button
                key={f}
                onClick={() => {
                  setFilter(f);
                  setPage(0);
                }}
                className={cn(
                  'px-2 py-0.5 rounded text-[9px] font-medium transition-all',
                  filter === f
                    ? 'bg-white/[0.08] text-white'
                    : 'text-white/40 hover:text-white/60'
                )}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <SearchInput
          value={search}
          onChange={(v) => {
            setSearch(v);
            setPage(0);
          }}
          placeholder="Search activity..."
        />
      </div>

      <div className="flex-1 overflow-y-auto px-4">
        {paginated.map((item) => (
          <ActivityItemView
            key={item.id}
            item={item}
            onArtifactClick={onArtifactClick}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex-shrink-0 px-4 py-2 border-t border-white/[0.04] flex items-center justify-between">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="p-1 rounded text-white/40 hover:text-white disabled:opacity-30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <span className="text-[10px] text-white/40">
            {page + 1} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
            disabled={page >= totalPages - 1}
            className="p-1 rounded text-white/40 hover:text-white disabled:opacity-30"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
      )}
    </PremiumCard>
  );
}
