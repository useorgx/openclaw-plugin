import { useMemo, useState } from 'react';
import type { Initiative } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { SearchInput } from '@/components/shared/SearchInput';
import { InitiativeCard } from './InitiativeCard';

interface InitiativePanelProps {
  initiatives: Initiative[];
  onInitiativeClick: (initiative: Initiative) => void;
  onCreateInitiative?: () => Promise<void> | void;
  onCreateWorkstream?: () => Promise<void> | void;
}

export function InitiativePanel({
  initiatives,
  onInitiativeClick,
  onCreateInitiative,
  onCreateWorkstream,
}: InitiativePanelProps) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [busyAction, setBusyAction] = useState<'initiative' | 'workstream' | null>(null);
  const pageSize = 3;

  const filtered = useMemo(
    () =>
      initiatives.filter((initiative) =>
        initiative.name.toLowerCase().includes(search.toLowerCase())
      ),
    [initiatives, search]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const paginated = filtered.slice(safePage * pageSize, (safePage + 1) * pageSize);

  const invokeAction = async (
    action: 'initiative' | 'workstream',
    callback: (() => Promise<void> | void) | undefined
  ) => {
    if (!callback || busyAction) return;
    setBusyAction(action);
    try {
      await callback();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <PremiumCard className="flex min-h-0 flex-1 flex-col">
      <div className="flex-shrink-0 space-y-2 border-b border-white/[0.06] px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-white">Initiatives</span>
          <span className="text-[10px] text-white/35">{initiatives.length}</span>
        </div>

        <SearchInput
          value={search}
          onChange={(next) => {
            setSearch(next);
            setPage(0);
          }}
          placeholder="Search initiatives..."
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => invokeAction('initiative', onCreateInitiative)}
            disabled={!onCreateInitiative || busyAction !== null}
            className="rounded-md border border-lime/25 bg-lime/10 px-2 py-1 text-[10px] font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
          >
            {busyAction === 'initiative' ? 'Creating…' : 'Start initiative'}
          </button>
          <button
            onClick={() => invokeAction('workstream', onCreateWorkstream)}
            disabled={!onCreateWorkstream || busyAction !== null}
            className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2 py-1 text-[10px] text-white/75 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'workstream' ? 'Creating…' : 'Start workstream'}
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {paginated.length === 0 && (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-center">
            <p className="text-[11px] text-white/45">
              {initiatives.length === 0
                ? 'No active initiatives yet.'
                : 'No initiatives match this search.'}
            </p>
          </div>
        )}

        {paginated.map((initiative) => (
          <InitiativeCard
            key={initiative.id}
            initiative={initiative}
            onClick={() => onInitiativeClick(initiative)}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex-shrink-0 border-t border-white/[0.06] px-4 py-2">
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="rounded p-1 text-white/45 transition-colors hover:text-white disabled:opacity-30"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="text-[10px] text-white/45">
              {safePage + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage >= totalPages - 1}
              className="rounded p-1 text-white/45 transition-colors hover:text-white disabled:opacity-30"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </PremiumCard>
  );
}
