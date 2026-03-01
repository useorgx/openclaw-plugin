import { motion } from 'framer-motion';
import { listItemVariants } from '@/lib/tokens';
import { sanitizeDisplayText } from '@/lib/humanize';

interface BlockerItem {
  id: string;
  description: string;
  agentName?: string | null;
  workstreamTitle?: string | null;
}

interface BlockerSummaryProps {
  blockers: BlockerItem[];
  onResolve?: (blockerId: string) => void;
  className?: string;
}

export function BlockerSummary({ blockers, onResolve, className }: BlockerSummaryProps) {
  if (blockers.length === 0) return null;

  return (
    <motion.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
    >
      <p className="section-kicker font-semibold mb-2">Blockers</p>
      <div className="space-y-2">
        {blockers.map((blocker, i) => (
          <motion.div
            key={blocker.id}
            className="subsection-shell rounded-xl px-4 py-3 border-red-400/20"
            variants={listItemVariants}
            custom={i}
          >
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5 h-2 w-2 flex-shrink-0 rounded-full bg-red-400/80" />
              <div className="min-w-0 flex-1">
                <p className="text-body text-primary leading-relaxed">
                  {sanitizeDisplayText(blocker.description)}
                </p>
                {(blocker.agentName || blocker.workstreamTitle) && (
                  <p className="mt-1 text-caption text-muted">
                    {blocker.agentName && <span>{blocker.agentName}</span>}
                    {blocker.agentName && blocker.workstreamTitle && <span> · </span>}
                    {blocker.workstreamTitle && <span>{blocker.workstreamTitle}</span>}
                  </p>
                )}
              </div>
              {onResolve && (
                <button
                  type="button"
                  onClick={() => onResolve(blocker.id)}
                  className="control-pill h-7 px-2.5 text-micro font-semibold flex-shrink-0"
                >
                  Resolve
                </button>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
