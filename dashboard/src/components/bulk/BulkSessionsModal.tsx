import { useEffect, useMemo, useState } from 'react';
import type { SessionTreeNode } from '@/types';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';

export type BulkSessionsMode = 'sessions' | 'active' | 'blocked' | 'failed';

type BulkAction = 'resume' | 'pause' | 'cancel';

const SESSION_STATUS_PRIORITY: Record<string, number> = {
  blocked: 0,
  failed: 1,
  running: 2,
  active: 2,
  queued: 3,
  in_progress: 3,
  pending: 4,
  paused: 5,
  cancelled: 6,
  completed: 7,
  archived: 8,
};

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sessionLastTouched(session: SessionTreeNode): number {
  return toEpoch(session.updatedAt ?? session.lastEventAt ?? session.startedAt);
}

function compareSessions(a: SessionTreeNode, b: SessionTreeNode): number {
  const aPriority = SESSION_STATUS_PRIORITY[(a.status ?? '').toLowerCase()] ?? 99;
  const bPriority = SESSION_STATUS_PRIORITY[(b.status ?? '').toLowerCase()] ?? 99;
  if (aPriority !== bPriority) return aPriority - bPriority;
  return sessionLastTouched(b) - sessionLastTouched(a);
}

function statusPillColor(status: string, blockerCount: number): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'failed') return colors.red;
  if (normalized === 'blocked' || blockerCount > 0) return colors.red;
  if (normalized === 'running' || normalized === 'active' || normalized === 'in_progress') {
    return colors.lime;
  }
  if (normalized === 'queued' || normalized === 'pending') return colors.amber;
  if (normalized === 'completed') return colors.teal;
  return colors.textMuted;
}

function modeTitle(mode: BulkSessionsMode): { title: string; subtitle: string } {
  switch (mode) {
    case 'active':
      return { title: 'Active Sessions', subtitle: 'Running and queued work across agents.' };
    case 'blocked':
      return { title: 'Blocked Sessions', subtitle: 'Work that needs attention before it can proceed.' };
    case 'failed':
      return { title: 'Failed Sessions', subtitle: 'Runs that exited with an error and may need a retry.' };
    default:
      return { title: 'Sessions', subtitle: 'All sessions visible to this dashboard.' };
  }
}

function modePredicate(mode: BulkSessionsMode, session: SessionTreeNode): boolean {
  const status = (session.status ?? '').toLowerCase();
  const blockerCount = session.blockers?.length ?? 0;
  if (mode === 'active') return ['running', 'active', 'queued', 'pending', 'in_progress'].includes(status);
  if (mode === 'blocked') return status === 'blocked' || blockerCount > 0;
  if (mode === 'failed') return status === 'failed';
  return true;
}

export function BulkSessionsModal({
  open,
  onClose,
  mode,
  sessions,
  onOpenSession,
  onRunAction,
  onRefetch,
  onSetNotice,
}: {
  open: boolean;
  onClose: () => void;
  mode: BulkSessionsMode;
  sessions: SessionTreeNode[];
  onOpenSession: (session: SessionTreeNode) => void;
  onRunAction: (session: SessionTreeNode, action: BulkAction) => Promise<void>;
  onRefetch: () => Promise<unknown>;
  onSetNotice: (message: string) => void;
}) {
  const { title, subtitle } = modeTitle(mode);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<{
    action: BulkAction;
    processed: number;
    total: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<{ text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setConfirmCancel(null);
  }, [open]);

  const scopedSessions = useMemo(() => sessions.filter((s) => modePredicate(mode, s)), [mode, sessions]);

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = {};
    for (const session of scopedSessions) {
      const key = (session.status ?? 'unknown').toLowerCase();
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }
    const blocked = scopedSessions.filter((s) => (s.status ?? '').toLowerCase() === 'blocked' || (s.blockers?.length ?? 0) > 0).length;
    const failed = scopedSessions.filter((s) => (s.status ?? '').toLowerCase() === 'failed').length;
    const active = scopedSessions.filter((s) => ['running', 'active', 'queued', 'pending', 'in_progress'].includes((s.status ?? '').toLowerCase())).length;
    return {
      total: scopedSessions.length,
      active,
      blocked,
      failed,
      byStatus,
    };
  }, [scopedSessions]);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    const base = [...scopedSessions].sort(compareSessions);
    if (!trimmed) return base;
    return base.filter((session) => {
      const haystack = [
        session.title,
        session.agentName,
        session.agentId,
        session.runId,
        session.lastEventSummary,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(trimmed);
    });
  }, [query, scopedSessions]);

  useEffect(() => {
    if (!open) return;
    setSelected((prev) => {
      const valid = new Set(filtered.map((s) => s.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (valid.has(id)) next.add(id);
      }
      return next;
    });
  }, [filtered, open]);

  const selectedCount = selected.size;
  const allSelected = filtered.length > 0 && filtered.every((s) => selected.has(s.id));

  const toggleAll = () => {
    if (busy) return;
    setSelected((prev) => {
      if (filtered.length === 0) return prev;
      if (allSelected) return new Set();
      return new Set(filtered.map((s) => s.id));
    });
  };

  const toggleOne = (sessionId: string) => {
    if (busy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const copyBlockers = async () => {
    if (selectedCount === 0 || busy) return;
    const lines: string[] = [];
    for (const session of filtered) {
      if (!selected.has(session.id)) continue;
      const blockers = session.blockers ?? [];
      if (blockers.length === 0) continue;
      lines.push(`- ${session.title} (${blockers.length} blocker${blockers.length === 1 ? '' : 's'})`);
      for (const blocker of blockers) {
        lines.push(`  - ${blocker}`);
      }
    }
    const text = lines.length > 0 ? lines.join('\n') : 'No blockers found for selected sessions.';
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied blockers to clipboard.');
    } catch {
      setNotice('Copy failed (clipboard unavailable).');
    }
  };

  const performBulkAction = async (action: BulkAction) => {
    if (selectedCount === 0 || busy) return;

    if (action === 'cancel') {
      setConfirmCancel({ text: '' });
      return;
    }

    const selectedSessions = filtered.filter((s) => selected.has(s.id));
    setNotice(null);
    setBusy({ action, processed: 0, total: selectedSessions.length });

    let failed = 0;
    for (const session of selectedSessions) {
      try {
        await onRunAction(session, action);
      } catch {
        failed += 1;
      } finally {
        setBusy((prev) =>
          prev
            ? { ...prev, processed: Math.min(prev.total, prev.processed + 1) }
            : prev
        );
      }
    }

    const succeeded = selectedSessions.length - failed;
    setBusy(null);
    if (failed > 0) {
      setNotice(`${action} finished: ${succeeded} ok, ${failed} failed.`);
    } else {
      setNotice(`${action} finished: ${succeeded} session${succeeded === 1 ? '' : 's'}.`);
    }

    try {
      await onRefetch();
    } catch {
      // ignore
    }

    if (action === 'resume') {
      onSetNotice(`Bulk resume requested: ${succeeded} ok${failed ? `, ${failed} failed` : ''}.`);
    } else if (action === 'pause') {
      onSetNotice(`Bulk pause requested: ${succeeded} ok${failed ? `, ${failed} failed` : ''}.`);
    }
  };

  const confirmCancelAction = async () => {
    if (!confirmCancel || busy) return;
    if (confirmCancel.text.trim().toUpperCase() !== 'CANCEL') return;

    const selectedSessions = filtered.filter((s) => selected.has(s.id));
    setNotice(null);
    setBusy({ action: 'cancel', processed: 0, total: selectedSessions.length });
    setConfirmCancel(null);

    let failed = 0;
    for (const session of selectedSessions) {
      try {
        await onRunAction(session, 'cancel');
      } catch {
        failed += 1;
      } finally {
        setBusy((prev) =>
          prev
            ? { ...prev, processed: Math.min(prev.total, prev.processed + 1) }
            : prev
        );
      }
    }

    const succeeded = selectedSessions.length - failed;
    setBusy(null);
    setNotice(`cancel finished: ${succeeded} ok${failed ? `, ${failed} failed` : ''}.`);
    onSetNotice(`Bulk cancel requested: ${succeeded} ok${failed ? `, ${failed} failed` : ''}.`);

    try {
      await onRefetch();
    } catch {
      // ignore
    }
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-4xl">
      <div className="flex h-full w-full flex-col">
        <div className="border-b border-subtle px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="inline-flex items-center gap-2 text-heading font-semibold text-white">
                <EntityIcon type="session" size={14} />
                <span className="truncate">{title}</span>
                <span className="rounded-full border border-strong bg-white/[0.04] px-2 py-0.5 text-caption font-semibold text-primary">
                  {counts.total}
                </span>
              </h3>
              <p className="mt-1 text-body leading-relaxed text-secondary">
                {subtitle}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colors.teal }} />
                  Total <span className="font-semibold text-white">{counts.total}</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: counts.active > 0 ? colors.lime : colors.textMuted }} />
                  Active <span className="font-semibold text-white">{counts.active}</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: counts.blocked > 0 ? colors.red : colors.textMuted }} />
                  Blocked <span className="font-semibold text-white">{counts.blocked}</span>
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.03] px-2 py-0.5 text-micro text-secondary">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: counts.failed > 0 ? colors.red : colors.textMuted }} />
                  Failed <span className="font-semibold text-white">{counts.failed}</span>
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-strong bg-white/[0.03] px-2.5 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08]"
              aria-label="Close bulk modal"
            >
              Close
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex-1">
              <label className="sr-only" htmlFor="bulk-sessions-search">
                Search sessions
              </label>
              <input
                id="bulk-sessions-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title, agent, run id…"
                data-modal-autofocus="true"
                className="w-full rounded-lg border border-strong bg-black/25 px-3 py-2 text-body text-white placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-[#BFFF00]/35"
              />
            </div>

            <button
              type="button"
              onClick={toggleAll}
              disabled={filtered.length === 0 || Boolean(busy)}
              className="rounded-lg border border-strong bg-white/[0.03] px-3 py-2 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              {allSelected ? 'Clear all' : `Select all (${filtered.length})`}
            </button>
          </div>

          {notice && (
            <div className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-body text-secondary">
              {notice}
            </div>
          )}

          {confirmCancel && (
            <div className="mt-3 rounded-xl border border-red-400/25 bg-red-500/[0.06] px-3 py-2.5">
              <p className="text-body font-semibold text-red-200">
                Cancel {selectedCount} session{selectedCount === 1 ? '' : 's'}?
              </p>
              <p className="mt-1 text-caption text-red-200/70">
                This is destructive. Type <span className="font-semibold">CANCEL</span> to confirm.
              </p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  value={confirmCancel.text}
                  onChange={(e) => setConfirmCancel({ text: e.target.value })}
                  placeholder="CANCEL"
                  className="flex-1 rounded-lg border border-red-300/25 bg-black/30 px-3 py-2 text-body text-white placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-red-300/40"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmCancel(null)}
                    className="rounded-lg border border-strong bg-white/[0.03] px-3 py-2 text-caption text-primary transition-colors hover:bg-white/[0.08]"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={confirmCancelAction}
                    disabled={confirmCancel.text.trim().toUpperCase() !== 'CANCEL'}
                    className="rounded-lg border border-red-300/25 bg-red-500/15 px-3 py-2 text-caption font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-45"
                  >
                    Confirm cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-subtle bg-white/[0.02] p-4 text-body text-secondary">
              No sessions match this view.
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((session) => {
                const isSelected = selected.has(session.id);
                const blockers = session.blockers ?? [];
                const pillColor = statusPillColor(session.status ?? '', blockers.length);
                const lastTouched = session.updatedAt ?? session.lastEventAt ?? session.startedAt;
                const subtitleParts = [
                  (session.agentName ?? session.agentId ?? '').trim() || 'Unknown agent',
                  (session.status ?? 'unknown').toLowerCase(),
                  lastTouched ? formatRelativeTime(lastTouched) : null,
                ].filter(Boolean);

                return (
                  <div
                    key={session.id}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2.5 transition-colors hover:bg-white/[0.04]"
                    style={{
                      borderColor: isSelected ? `${colors.lime}40` : 'rgba(255,255,255,0.08)',
                    }}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleOne(session.id)}
                        disabled={Boolean(busy)}
                        className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                        aria-label={`Select session ${session.title}`}
                      />

                      <button
                        type="button"
                        onClick={() => onOpenSession(session)}
                        disabled={Boolean(busy)}
                        className="min-w-0 flex-1 text-left"
                        title="Open session inspector"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-body font-medium text-white">
                              {session.title}
                            </p>
                            <p className="mt-0.5 text-caption text-secondary">
                              {subtitleParts.join(' · ')}
                            </p>
                            {session.lastEventSummary && (
                              <p className="mt-1 line-clamp-2 text-caption text-secondary">
                                {session.lastEventSummary}
                              </p>
                            )}
                            {blockers.length > 0 && (
                              <p className="mt-1 text-micro text-red-200/80">
                                {blockers.length} blocker{blockers.length === 1 ? '' : 's'} · {blockers[0]}
                              </p>
                            )}
                          </div>

                          <span
                            className="shrink-0 rounded-full border px-2 py-0.5 text-micro font-semibold uppercase tracking-[0.08em]"
                            style={{
                              borderColor: `${pillColor}30`,
                              backgroundColor: `${pillColor}14`,
                              color: pillColor,
                            }}
                          >
                            {(session.status ?? 'unknown').toUpperCase()}
                          </span>
                        </div>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-subtle px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-caption text-secondary">
            {busy ? (
              <span>
                {busy.action} {busy.processed}/{busy.total}
              </span>
            ) : (
              <span>{selectedCount > 0 ? `${selectedCount} selected` : 'No selection'}</span>
            )}
            {mode === 'blocked' && (
              <button
                type="button"
                onClick={copyBlockers}
                disabled={selectedCount === 0 || Boolean(busy)}
                className="rounded-md border border-strong bg-white/[0.03] px-2.5 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
              >
                Copy blockers
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                const one = filtered.find((s) => selected.has(s.id)) ?? null;
                if (one) {
                  onOpenSession(one);
                }
              }}
              disabled={selectedCount !== 1 || Boolean(busy)}
              className="rounded-md border border-strong bg-white/[0.03] px-3 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              Open inspector
            </button>

            <button
              type="button"
              onClick={() => void performBulkAction('resume')}
              disabled={selectedCount === 0 || Boolean(busy)}
              className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/20 disabled:opacity-45"
            >
              Resume selected
            </button>

            <button
              type="button"
              onClick={() => void performBulkAction('pause')}
              disabled={selectedCount === 0 || Boolean(busy)}
              className="rounded-md border border-strong bg-white/[0.03] px-3 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08] disabled:opacity-45"
            >
              Pause selected
            </button>

            <button
              type="button"
              onClick={() => void performBulkAction('cancel')}
              disabled={selectedCount === 0 || Boolean(busy)}
              className="rounded-md border border-red-300/25 bg-red-500/10 px-3 py-1.5 text-caption font-semibold text-red-200 transition-colors hover:bg-red-500/15 disabled:opacity-45"
            >
              Cancel selected
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

