import { useState, useCallback, useMemo, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LiveTriageItem, TriageSeverity } from '@/types';
import type { TriageQueueModel, TriageQueueActions } from '@/hooks/useTriageQueue';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 40;

const SEVERITY_COLORS: Record<TriageSeverity, string> = {
  critical: '#FF6B6B',
  high: '#F5B700',
  medium: '#0AD4C4',
  low: '#8B8FA3',
};

const SEVERITY_BG: Record<TriageSeverity, string> = {
  critical: 'bg-[#FF6B6B]/14',
  high: 'bg-[#F5B700]/14',
  medium: 'bg-[#0AD4C4]/14',
  low: 'bg-white/[0.06]',
};

const SEVERITY_TEXT: Record<TriageSeverity, string> = {
  critical: 'text-[#FFA8A8]',
  high: 'text-[#FFE7A8]',
  medium: 'text-[#7AEDE5]',
  low: 'text-secondary',
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: TriageSeverity }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_BG[severity]} ${SEVERITY_TEXT[severity]}`}
    >
      {severity}
    </span>
  );
}

function OccurrenceBadge({ count }: { count: number }) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold text-secondary">
      ×{count}
    </span>
  );
}

function ImpactChips({ item }: { item: LiveTriageItem }) {
  const chips: string[] = [];
  if (item.impact.workstreamCount > 1) {
    chips.push(`${item.impact.workstreamCount} workstreams`);
  }
  if (item.impact.downstreamBlockedCount > 0) {
    chips.push(`${item.impact.downstreamBlockedCount} blocked downstream`);
  }
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <span
          key={chip}
          className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-muted"
        >
          {chip}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function TriageCard({
  item,
  isSelected,
  onSelect,
  onClick,
}: {
  item: LiveTriageItem;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onClick: (item: LiveTriageItem) => void;
}) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.22 }}
      className="group cursor-pointer rounded-lg border border-subtle bg-white/[0.02] p-3 transition-colors hover:bg-white/[0.04]"
      onClick={() => onClick(item)}
    >
      {/* Line 1: Title + severity */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={(e) => {
              e.stopPropagation();
              onSelect(item.id);
            }}
            onClick={(e) => e.stopPropagation()}
            className="h-3.5 w-3.5 rounded border-white/20 bg-transparent accent-[#0AD4C4] flex-shrink-0"
          />
          <span className="text-body font-medium text-primary truncate">
            {item.title}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <OccurrenceBadge count={item.occurrenceCount} />
          <SeverityBadge severity={item.severity} />
        </div>
      </div>

      {/* Line 2: Scope path */}
      {(item.initiativeTitle || item.workstreamTitle) && (
        <div className="mt-1 ml-5.5 text-micro text-muted truncate">
          {[item.initiativeTitle, item.workstreamTitle].filter(Boolean).join(' › ')}
        </div>
      )}

      {/* Line 3: Root cause + occurrence */}
      <div className="mt-1.5 ml-5.5 text-caption text-secondary leading-snug line-clamp-2">
        {item.summary}
      </div>

      {/* Line 4: Recommended action + impact */}
      <div className="mt-1.5 ml-5.5 flex items-center gap-2 flex-wrap">
        {item.recommendedAction && (
          <span className="text-micro text-[#7AEDE5] font-medium">
            → {item.recommendedAction}
          </span>
        )}
        <ImpactChips item={item} />
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Actions Footer
// ---------------------------------------------------------------------------

function BulkActionsFooter({
  selectedCount,
  onApproveAll,
  onDismissAll,
  onClearSelection,
  isActing,
}: {
  selectedCount: number;
  onApproveAll: () => void;
  onDismissAll: () => void;
  onClearSelection: () => void;
  isActing: boolean;
}) {
  if (selectedCount === 0) return null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-subtle bg-[#0E0F11]/95 backdrop-blur-sm px-3 py-2"
    >
      <span className="text-caption text-secondary">
        {selectedCount} selected
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClearSelection}
          className="text-caption text-muted hover:text-secondary transition-colors"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onDismissAll}
          disabled={isActing}
          className="rounded-full bg-white/[0.08] px-3 py-1 text-caption font-medium text-secondary hover:bg-white/[0.12] transition-colors disabled:opacity-40"
        >
          Dismiss all
        </button>
        <button
          type="button"
          onClick={onApproveAll}
          disabled={isActing}
          className="rounded-full bg-[#0AD4C4]/20 px-3 py-1 text-caption font-medium text-[#7AEDE5] hover:bg-[#0AD4C4]/30 transition-colors disabled:opacity-40"
        >
          Approve all
        </button>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Empty States
// ---------------------------------------------------------------------------

function TriageEmptyState({
  status,
  degraded,
}: {
  status: string;
  degraded: string[];
}) {
  if (degraded.length > 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
        <div className="rounded-full bg-[#F5B700]/14 px-3 py-1 text-micro font-semibold text-[#FFE7A8]">
          Partial data
        </div>
        <p className="text-body text-secondary max-w-xs">
          Connection degraded. Missing: {degraded.join(', ')}. Partial triage loaded.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-muted"
      >
        <path d="M12 3 5 6v6c0 5 3.3 7.8 7 9 3.7-1.2 7-4 7-9V6z" />
        <path d="m9 12.5 2 2 4-4" />
      </svg>
      <p className="text-body font-medium text-secondary">
        No open triage items
      </p>
      <p className="text-caption text-muted max-w-xs">
        {status === 'open'
          ? 'No items need attention in this workspace right now.'
          : `No ${status} triage items found.`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export interface TriageQueueProps {
  model: TriageQueueModel;
  actions: TriageQueueActions;
  onOpenDetail: (item: LiveTriageItem) => void;
  className?: string;
}

export function TriageQueue({
  model,
  actions,
  onOpenDetail,
  className,
}: TriageQueueProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);

  // Reset selection when items change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [model.items.length]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleItems = useMemo(() => {
    const start = page * PAGE_SIZE;
    return model.items.slice(start, start + PAGE_SIZE);
  }, [model.items, page]);

  const handleApproveAll = useCallback(async () => {
    for (const id of selectedIds) {
      try {
        await actions.performAction(id, 'approve');
      } catch {
        // continue with remaining
      }
    }
    setSelectedIds(new Set());
  }, [selectedIds, actions]);

  const handleDismissAll = useCallback(async () => {
    for (const id of selectedIds) {
      try {
        await actions.performAction(id, 'dismiss');
      } catch {
        // continue with remaining
      }
    }
    setSelectedIds(new Set());
  }, [selectedIds, actions]);

  if (model.isLoading) {
    return (
      <div className={`flex flex-col gap-2 p-2 ${className ?? ''}`}>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-20 rounded-lg shimmer-skeleton"
          />
        ))}
      </div>
    );
  }

  if (model.items.length === 0) {
    return (
      <div className={className}>
        <TriageEmptyState status="open" degraded={model.degraded} />
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col ${className ?? ''}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-subtle">
        <div className="flex items-center gap-2">
          <h3 className="text-caption font-semibold text-primary">Triage</h3>
          <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold text-secondary tabular-nums">
            {model.total}
          </span>
        </div>
        {model.degraded.length > 0 && (
          <span className="rounded-full bg-[#F5B700]/14 px-2 py-0.5 text-[10px] font-semibold text-[#FFE7A8]">
            Partial
          </span>
        )}
      </div>

      {/* Items */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 space-y-1.5">
        <AnimatePresence mode="popLayout">
          {visibleItems.map((item) => (
            <TriageCard
              key={item.id}
              item={item}
              isSelected={selectedIds.has(item.id)}
              onSelect={toggleSelect}
              onClick={onOpenDetail}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Pagination */}
      {model.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-2 border-t border-subtle px-3 py-1.5">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="text-caption text-muted hover:text-secondary disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-micro text-muted tabular-nums">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, model.total)} of{' '}
            {model.total}
          </span>
          <button
            type="button"
            disabled={(page + 1) * PAGE_SIZE >= model.total}
            onClick={() => setPage((p) => p + 1)}
            className="text-caption text-muted hover:text-secondary disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}

      {/* Bulk Actions */}
      <AnimatePresence>
        <BulkActionsFooter
          selectedCount={selectedIds.size}
          onApproveAll={handleApproveAll}
          onDismissAll={handleDismissAll}
          onClearSelection={() => setSelectedIds(new Set())}
          isActing={actions.isActing}
        />
      </AnimatePresence>
    </div>
  );
}
