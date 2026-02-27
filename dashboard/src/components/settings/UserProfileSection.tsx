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
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-5">
      <div className="flex items-center gap-5">
        {/* Avatar */}
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
            <UserFractalAvatar seed={avatarSeed} size={80} />
          </motion.div>
        </AnimatePresence>

        {/* Details */}
        <div className="min-w-0 flex-1">
          <p className="text-micro uppercase tracking-[0.08em] text-muted">
            Your identity
          </p>

          {editing ? (
            <div className="mt-1.5 flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleKeyDown}
                maxLength={64}
                placeholder="Enter your name"
                className="h-8 flex-1 rounded-lg border border-white/[0.12] bg-white/[0.04] px-2.5 text-heading font-semibold text-white placeholder:text-muted focus:border-lime/30 focus:outline-none"
              />
              <button
                type="button"
                onClick={commitEdit}
                className="rounded-lg bg-lime/[0.12] px-3 py-1.5 text-caption font-medium text-lime transition hover:bg-lime/[0.2]"
              >
                Save
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="rounded-lg px-3 py-1.5 text-caption text-secondary transition hover:bg-white/[0.04]"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <h4 className="text-heading font-semibold text-white">
                {displayName || 'Anonymous'}
              </h4>
              <button
                type="button"
                onClick={startEdit}
                className="rounded-md px-2 py-0.5 text-caption text-secondary transition hover:bg-white/[0.06] hover:text-white"
              >
                {displayName ? 'Edit' : 'Add name'}
              </button>
            </div>
          )}

          {/* Status */}
          <div className="mt-2 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span
                className={cn(
                  'relative inline-flex h-2 w-2 rounded-full',
                  isConnected
                    ? 'bg-lime'
                    : connectionPhase === 'error'
                      ? 'bg-red-400'
                      : 'bg-white/30',
                )}
              />
            </span>
            <span className="text-caption text-secondary">{statusLabel}</span>
          </div>

          {/* Regenerate */}
          <button
            type="button"
            onClick={regenerateAvatar}
            className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-caption text-secondary transition hover:bg-white/[0.06] hover:text-white"
          >
            Regenerate avatar
          </button>
        </div>
      </div>
    </div>
  );
}
