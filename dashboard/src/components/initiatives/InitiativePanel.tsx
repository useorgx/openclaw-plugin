import { useMemo, useState } from 'react';
import type { Initiative } from '@/types';
import { colors } from '@/lib/tokens';
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
    <PremiumCard className="flex h-full min-h-0 flex-1 flex-col card-enter">
      <div className="flex-shrink-0 space-y-2 border-b border-subtle px-4 py-3.5">
        <div className="flex items-center justify-between">
          <span className="text-heading font-semibold text-white">Initiatives</span>
          <span className="text-body text-muted">{initiatives.length}</span>
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
            className="rounded-md border border-lime/25 bg-lime/10 px-2.5 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
          >
            {busyAction === 'initiative' ? 'Creating…' : 'Start initiative'}
          </button>
          <button
            onClick={() => invokeAction('workstream', onCreateWorkstream)}
            disabled={!onCreateWorkstream || busyAction !== null}
            className="rounded-md border border-strong bg-white/[0.03] px-2.5 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
          >
            {busyAction === 'workstream' ? 'Creating…' : 'Start workstream'}
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {paginated.length === 0 && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-subtle bg-white/[0.02] p-4 text-center">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-faint"
            >
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            <p className="text-body text-secondary">
              {initiatives.length === 0
                ? 'No active initiatives yet. Start one above.'
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
        <div className="flex-shrink-0 overflow-visible border-t border-subtle px-4 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => setPage(Math.max(0, safePage - 1))}
              disabled={safePage === 0}
              className="flex-shrink-0 rounded p-1.5 text-secondary transition-colors hover:text-white disabled:opacity-30"
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
            <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5 overflow-x-auto">
              {Array.from({ length: totalPages }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setPage(i)}
                  aria-label={`Page ${i + 1}`}
                  className="rounded-full p-1 transition-colors"
                >
                  <span
                    className="block h-2.5 w-2.5 rounded-full transition-colors"
                    style={{
                      backgroundColor: i === safePage ? colors.lime : 'rgba(255,255,255,0.25)',
                    }}
                  />
                </button>
              ))}
            </div>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              disabled={safePage >= totalPages - 1}
              className="flex-shrink-0 rounded p-1.5 text-secondary transition-colors hover:text-white disabled:opacity-30"
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
