import { useState } from 'react';
import type { Initiative } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { SearchInput } from '@/components/shared/SearchInput';
import { InitiativeCard } from './InitiativeCard';

interface InitiativePanelProps {
  initiatives: Initiative[];
  onInitiativeClick: (initiative: Initiative) => void;
}

export function InitiativePanel({
  initiatives,
  onInitiativeClick,
}: InitiativePanelProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 5;

  const filtered = initiatives.filter((i) =>
    i.name.toLowerCase().includes(search.toLowerCase())
  );
  const totalPages = Math.ceil(filtered.length / pageSize);
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

  if (initiatives.length === 0) {
    return (
      <PremiumCard className="flex-1 flex flex-col min-h-0">
        <div className="px-4 py-3 border-b border-white/[0.04]">
          <span className="text-[13px] font-medium text-white">Initiatives</span>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="text-center">
            <svg className="mx-auto mb-2 text-white/20" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" />
            </svg>
            <p className="text-[11px] text-white/40">No active initiatives</p>
          </div>
        </div>
      </PremiumCard>
    );
  }

  return (
    <PremiumCard className="flex-1 flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 py-3 border-b border-white/[0.04]">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-medium text-white">Initiatives</span>
          <span className="text-[10px] text-white/30">{initiatives.length}</span>
        </div>
        {initiatives.length > 3 && (
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search..."
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {paginated.map((initiative) => (
          <InitiativeCard
            key={initiative.id}
            initiative={initiative}
            onClick={() => onInitiativeClick(initiative)}
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
