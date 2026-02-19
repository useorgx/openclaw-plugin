import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';

interface WhileYouWereAwayProps {
  completedCount: number;
  decisionsCount: number;
  blockerCount: number;
  visible: boolean;
  onDismiss: () => void;
}

export function WhileYouWereAway({
  completedCount,
  decisionsCount,
  blockerCount,
  visible,
  onDismiss,
}: WhileYouWereAwayProps) {
  const hasContent = completedCount > 0 || decisionsCount > 0 || blockerCount > 0;

  if (!hasContent) return null;

  const bullets: string[] = [];
  if (completedCount > 0) bullets.push(`${completedCount} task${completedCount === 1 ? '' : 's'} completed`);
  if (decisionsCount > 0) bullets.push(`${decisionsCount} need${decisionsCount === 1 ? 's' : ''} decisions`);
  if (blockerCount > 0) bullets.push(`${blockerCount} new blocker${blockerCount === 1 ? '' : 's'}`);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: 'auto', marginBottom: 12 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div
            className="rounded-xl px-4 py-3"
            style={{
              backgroundColor: `${colors.teal}08`,
              border: `1px solid ${colors.teal}20`,
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-caption font-semibold text-white">While you were away</p>
                <p className="mt-1 text-body text-secondary">
                  {bullets.join(' · ')}
                </p>
              </div>
              <button
                onClick={onDismiss}
                className="flex-shrink-0 rounded-md px-2.5 py-1 text-caption font-medium text-secondary transition-colors hover:bg-white/[0.06] hover:text-white"
              >
                Got it
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
