import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useRef, useState } from 'react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { UserFractalAvatar } from '@/components/settings/UserFractalAvatar';
import { motion as motionTokens } from '@/lib/tokens';
import { cn } from '@/lib/utils';

type ConnectionPhase = 'connected' | 'connecting' | 'error' | 'idle';

interface UserProfileSectionProps {
  connectionPhase: ConnectionPhase;
  workspaceName?: string | null;
}

export function UserProfileSection({
  connectionPhase,
  workspaceName,
}: UserProfileSectionProps) {
  const { displayName, avatarSeed, updateName, regenerateAvatar } =
    useUserProfile();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = useCallback(() => {
    setDraft(displayName);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [displayName]);

  const commitEdit = useCallback(() => {
    updateName(draft);
    setEditing(false);
  }, [draft, updateName]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') commitEdit();
      else if (e.key === 'Escape') cancelEdit();
    },
    [commitEdit, cancelEdit],
  );

  const isConnected = connectionPhase === 'connected';
  const statusLabel = isConnected
    ? `Connected${workspaceName ? ` to ${workspaceName}` : ''}`
    : connectionPhase === 'connecting'
      ? 'Connecting...'
      : connectionPhase === 'error'
        ? 'Connection error'
        : 'Not connected';

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <div className="rounded-xl border border-white/[0.08] bg-black/20 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-micro uppercase tracking-[0.14em] text-[#D8FFA1]/78">Visual signature</p>
          <span
            className={cn(
              'rounded-full border px-2 py-0.5 text-micro uppercase tracking-[0.08em]',
              isConnected
                ? 'border-lime/28 bg-lime/[0.10] text-[#D8FFA1]'
                : connectionPhase === 'error'
                  ? 'border-rose-300/25 bg-rose-500/[0.12] text-rose-100'
                  : 'border-white/[0.14] bg-white/[0.04] text-secondary'
            )}
          >
            {isConnected
              ? 'Connected'
              : connectionPhase === 'connecting'
                ? 'Connecting'
                : connectionPhase === 'error'
                  ? 'Attention'
                  : 'Idle'}
          </span>
        </div>

        <div className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-4">
          <AnimatePresence mode="wait">
            <motion.div
              key={avatarSeed}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{
                duration: 0.3,
                ease: motionTokens.easingEntrance as unknown as number[],
              }}
            >
              <UserFractalAvatar seed={avatarSeed} size={88} />
            </motion.div>
          </AnimatePresence>
          <button
            type="button"
            onClick={regenerateAvatar}
            className="min-h-[44px] rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.07]"
          >
            Regenerate signature
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.06] pb-4">
          <div className="min-w-0">
            <p className="text-micro uppercase tracking-[0.14em] text-[#D8FFA1]/78">Operator profile</p>
            {!editing ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <h4 className="truncate text-[24px] font-semibold leading-tight tracking-[-0.02em] text-white">
                  {displayName || 'Anonymous'}
                </h4>
                <button
                  type="button"
                  onClick={startEdit}
                  className="rounded-full border border-white/[0.12] bg-white/[0.03] px-3 py-1 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.07]"
                >
                  {displayName ? 'Edit name' : 'Add name'}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  ref={inputRef}
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  maxLength={64}
                  placeholder="Enter your name"
                  className="h-11 min-w-0 flex-1 rounded-xl border border-white/[0.12] bg-black/25 px-3 text-body font-semibold text-white placeholder:text-muted focus:border-lime/30 focus:outline-none"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={commitEdit}
                    className="min-h-[44px] rounded-full bg-lime/[0.12] px-4 py-2 text-caption font-semibold text-lime transition-colors hover:bg-lime/[0.2]"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="min-h-[44px] rounded-full border border-white/[0.12] bg-white/[0.03] px-4 py-2 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.07]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <p className="mt-2 text-body leading-relaxed text-secondary">
              This name and signature appear across mission control, approvals, and local operator context.
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3">
            <p className="text-micro uppercase tracking-[0.12em] text-muted">Connection</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span
                  className={cn(
                    'relative inline-flex h-2.5 w-2.5 rounded-full',
                    isConnected
                      ? 'bg-lime'
                      : connectionPhase === 'error'
                        ? 'bg-red-400'
                        : 'bg-white/30',
                  )}
                />
              </span>
              <span className="text-body font-semibold text-primary">{statusLabel}</span>
            </div>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-black/20 px-4 py-3">
            <p className="text-micro uppercase tracking-[0.12em] text-muted">Workspace</p>
            <p className="mt-2 text-body font-semibold text-primary">{workspaceName ?? 'No workspace selected yet'}</p>
            <p className="mt-1 text-caption text-secondary">
              {workspaceName ? 'Current live scope for synced operations.' : 'Connection scope appears here after verification.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
