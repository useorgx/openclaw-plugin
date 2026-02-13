import { useMemo, useState } from 'react';
import type { OutboxStatus } from '@/types';
import { Modal } from '@/components/shared/Modal';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { colors } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';

function formatIsoRelative(value: string | null): string {
  if (!value) return 'unknown';
  try {
    return formatRelativeTime(value);
  } catch {
    return 'unknown';
  }
}

export function BulkOutboxModal({
  open,
  onClose,
  outbox,
  onOpenSettings,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  outbox: OutboxStatus;
  onOpenSettings: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const sortedQueues = useMemo(() => {
    const entries = Object.entries(outbox.pendingByQueue ?? {});
    return entries
      .filter(([, count]) => typeof count === 'number' && count > 0)
      .sort((a, b) => b[1] - a[1]);
  }, [outbox.pendingByQueue]);

  const statusColor = useMemo(() => {
    if (outbox.replayStatus === 'error') return colors.red;
    if (outbox.pendingTotal > 0) return colors.amber;
    return colors.textMuted;
  }, [outbox.pendingTotal, outbox.replayStatus]);

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(outbox, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl" fitContent>
      <div className="flex w-full flex-col">
        <div className="border-b border-subtle px-5 pt-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="inline-flex items-center gap-2 text-heading font-semibold text-white">
                <EntityIcon type="outbox" size={14} />
                <span className="truncate">Outbox</span>
                <span
                  className="rounded-full border px-2 py-0.5 text-caption font-semibold"
                  style={{
                    borderColor: `${statusColor}30`,
                    backgroundColor: `${statusColor}14`,
                    color: statusColor,
                  }}
                >
                  {outbox.pendingTotal}
                </span>
              </h3>
              <p className="mt-1 text-body leading-relaxed text-secondary">
                Buffered updates queued for replay to OrgX when connectivity is healthy.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-strong bg-white/[0.03] px-2.5 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08]"
              aria-label="Close outbox modal"
            >
              Close
            </button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <p className="text-micro uppercase tracking-[0.12em] text-secondary">Replay status</p>
              <p className="mt-1 text-body font-semibold" style={{ color: statusColor }}>
                {outbox.replayStatus}
              </p>
              {outbox.lastReplayError && outbox.replayStatus === 'error' && (
                <p className="mt-1 line-clamp-2 text-caption text-red-200/75">
                  {outbox.lastReplayError}
                </p>
              )}
            </div>
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2">
              <p className="text-micro uppercase tracking-[0.12em] text-secondary">Window</p>
              <p className="mt-1 text-caption text-primary">
                Oldest: <span className="font-semibold text-white">{formatIsoRelative(outbox.oldestEventAt)}</span>
              </p>
              <p className="mt-0.5 text-caption text-primary">
                Newest: <span className="font-semibold text-white">{formatIsoRelative(outbox.newestEventAt)}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          {outbox.pendingTotal === 0 ? (
            <div className="rounded-xl border border-subtle bg-white/[0.02] p-4 text-body text-secondary">
              Outbox is empty.
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-caption font-semibold uppercase tracking-[0.12em] text-secondary">
                  Queues
                </p>
                <button
                  type="button"
                  onClick={handleCopyJson}
                  className="rounded-md border border-strong bg-white/[0.03] px-2.5 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.08]"
                >
                  {copied ? 'Copied' : 'Copy JSON'}
                </button>
              </div>

              <div className="space-y-1.5">
                {sortedQueues.map(([queueId, count]) => (
                  <div
                    key={queueId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-body font-medium text-white">
                        {queueId}
                      </p>
                      <p className="mt-0.5 text-micro text-secondary">
                        {count} event{count === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className="rounded-full border px-2 py-0.5 text-caption font-semibold"
                      style={{
                        borderColor: `${colors.amber}30`,
                        backgroundColor: `${colors.amber}14`,
                        color: colors.amber,
                      }}
                    >
                      {count}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-subtle bg-white/[0.02] px-3 py-2 text-caption text-secondary">
                Replay is handled automatically by the OrgX sync service. If events stay queued, check Settings for API key and last replay errors.
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-strong bg-white/[0.03] px-3 py-1.5 text-caption text-primary transition-colors hover:bg-white/[0.08]"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md border border-lime/25 bg-lime/10 px-3 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/20"
          >
            Open settings
          </button>
        </div>
      </div>
    </Modal>
  );
}

