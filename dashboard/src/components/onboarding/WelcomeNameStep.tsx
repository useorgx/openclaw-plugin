import { motion } from 'framer-motion';
import { useCallback, useState } from 'react';
import { useUserProfile } from '@/hooks/useUserProfile';
import { UserFractalAvatar } from '@/components/settings/UserFractalAvatar';
import { motion as motionTokens } from '@/lib/tokens';

interface WelcomeNameStepProps {
  onComplete: () => void;
}

export function WelcomeNameStep({ onComplete }: WelcomeNameStepProps) {
  const { displayName, avatarSeed, updateName } = useUserProfile();
  const [localName, setLocalName] = useState(displayName);

  const handleContinue = useCallback(() => {
    updateName(localName);
    onComplete();
  }, [localName, updateName, onComplete]);

  const handleSkip = useCallback(() => {
    onComplete();
  }, [onComplete]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleContinue();
    },
    [handleContinue],
  );

  // Live-update the seed as the user types
  const liveSeed = (localName.trim() || 'orgx-user') + '';

  return (
    <motion.div
      initial={{ opacity: 0, y: 14, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.985 }}
      transition={{
        duration: 0.32,
        ease: motionTokens.easingEntrance as unknown as number[],
      }}
      className="flex items-center justify-center"
    >
      <div className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[--orgx-surface-elevated] p-6 sm:p-8">
        <div className="flex flex-col items-center text-center">
          <UserFractalAvatar seed={liveSeed} size={96} />

          <h2 className="mt-5 text-title font-medium text-white">
            Welcome to OrgX
          </h2>
          <p className="mt-2 text-body leading-relaxed text-secondary">
            What should we call you? This appears in your settings and is stored
            locally.
          </p>

          <input
            type="text"
            value={localName}
            onChange={(e) => setLocalName(e.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={64}
            autoFocus
            placeholder="Your name"
            className="mt-5 h-10 w-full max-w-xs rounded-xl border border-white/[0.12] bg-white/[0.04] px-4 text-center text-body text-white placeholder:text-muted focus:border-lime/30 focus:outline-none"
          />

          <button
            type="button"
            onClick={handleContinue}
            className="mt-5 rounded-full bg-lime px-6 py-2.5 text-body font-medium text-black transition hover:brightness-110"
          >
            {localName.trim() ? 'Continue' : 'Continue without name'}
          </button>

          {localName.trim() && (
            <button
              type="button"
              onClick={handleSkip}
              className="mt-3 text-caption text-secondary transition hover:text-white"
            >
              Skip
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
