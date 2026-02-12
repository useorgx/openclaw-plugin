import { useEffect, useMemo, useState } from 'react';
import type { HandoffSummary } from '@/types';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';

function statusColor(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'fulfilled' || normalized === 'completed') return colors.lime;
  if (normalized === 'claimed') return colors.teal;
  if (normalized === 'blocked') return colors.red;
  return colors.amber;
}

export function BulkHandoffsModal({
  open,
  onClose,
  handoffs,
}: {
  open: boolean;
  onClose: () => void;
  handoffs: HandoffSummary[];
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCopied(null);
  }, [open]);

  const ordered = useMemo(() => {
    return [...handoffs].sort(
      (a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? '')
    );
  }, [handoffs]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((handoff) => {
      const haystack = [handoff.title, handoff.summary, handoff.status, handoff.priority]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [ordered, query]);

  useEffect(() => {
    if (!open) return;
    setSelected((prev) => {
      const ids = new Set(filtered.map((h) => h.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (ids.has(id)) next.add(id);
      }
      return next;
    });
  }, [filtered, open]);

  const selectedCount = selected.size;
  const allSelected = filtered.length > 0 && filtered.every((h) => selected.has(h.id));

  const toggleAll = () => {
    setSelected((prev) => {
      if (filtered.length === 0) return prev;
      if (allSelected) return new Set();
      return new Set(filtered.map((h) => h.id));
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyMarkdown = async () => {
    const items = filtered.filter((h) => selectedCount === 0 || selected.has(h.id));
    const lines: string[] = [];
    lines.push(`# Handoffs (${items.length})`);
    lines.push('');
    for (const handoff of items) {
      lines.push(`- **${handoff.title}** — ${handoff.status}${handoff.priority ? ` (priority: ${handoff.priority})` : ''}`);
      if (handoff.summary) lines.push(`  - ${handoff.summary}`);
      lines.push(`  - Updated: ${handoff.updatedAt}`);
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('Copied markdown.');
      setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied('Copy failed (clipboard unavailable).');
    }
  };

  const copyJson = async () => {
    const items = filtered.filter((h) => selectedCount === 0 || selected.has(h.id));
    try {
      await navigator.clipboard.writeText(JSON.stringify(items, null, 2));
      setCopied('Copied JSON.');
      setTimeout(() => setCopied(null), 1200);
    } catch {
      setCopied('Copy failed (clipboard unavailable).');
    }
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      <div className="flex h-full w-full flex-col">
        <div className="border-b border-white/[0.06] px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="inline-flex items-center gap-2 text-[15px] font-semibold text-white">
                <EntityIcon type="handoff" size={14} />
                <span className="truncate">Handoffs</span>
                <span className="rounded-full border border-white/[0.12] bg-white/[0.04] px-2 py-0.5 text-[11px] font-semibold text-white/75">
                  {handoffs.length}
                </span>
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-white/45">
                Review and export current handoffs. Select items for a tighter export.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-white/[0.12] bg-white/[0.03] px-2.5 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08]"
              aria-label="Close handoffs modal"
            >
              Close
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex-1">
              <label className="sr-only" htmlFor="bulk-handoffs-search">
                Search handoffs
              </label>
              <input
                id="bulk-handoffs-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, summary, status…"
                data-modal-autofocus="true"
                className="w-full rounded-lg border border-white/[0.12] bg-black/25 px-3 py-2 text-[12px] text-white placeholder:text-white/30 focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/35"
              />
            </div>

            <button
              type="button"
              onClick={toggleAll}
              disabled={filtered.length === 0}
              className="rounded-lg border border-white/[0.12] bg-white/[0.03] px-3 py-2 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              {allSelected ? 'Clear all' : `Select all (${filtered.length})`}
            </button>
          </div>

          {copied && (
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[12px] text-white/60">
              {copied}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 text-[12px] text-white/45">
              No handoffs match this view.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((handoff) => {
                const isSelected = selected.has(handoff.id);
                const accent = statusColor(handoff.status);
                return (
                  <div
                    key={handoff.id}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5"
                    style={{
                      borderColor: isSelected ? `${colors.lime}40` : 'rgba(255,255,255,0.08)',
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(handoff.id)}
                        className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                        aria-label={`Select handoff ${handoff.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-white">
                              {handoff.title}
                            </p>
                            {handoff.summary && (
                              <p className="mt-1 line-clamp-2 text-[11px] text-white/60">
                                {handoff.summary}
                              </p>
                            )}
                            <p className="mt-1 text-[10px] text-white/45">
                              Updated {formatRelativeTime(handoff.updatedAt)}
                            </p>
                          </div>

                          <span
                            className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                            style={{
                              borderColor: `${accent}30`,
                              backgroundColor: `${accent}14`,
                              color: accent,
                            }}
                          >
                            {handoff.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-white/[0.06] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-[11px] text-white/45">
            {selectedCount > 0 ? `${selectedCount} selected` : 'No selection (exporting will include all filtered handoffs)'}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={copyMarkdown}
              disabled={filtered.length === 0}
              className="rounded-md border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              Copy markdown
            </button>
            <button
              type="button"
              onClick={copyJson}
              disabled={filtered.length === 0}
              className="rounded-md border border-white/[0.12] bg-white/[0.03] px-3 py-1.5 text-[11px] text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              Copy JSON
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

