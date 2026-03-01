import { motion } from 'framer-motion';
import { listItemVariants, colors } from '@/lib/tokens';
import type { SliceRunArtifactSummary } from '@/types';

interface ArtifactGalleryProps {
  artifacts: SliceRunArtifactSummary[];
  onOpenArtifact?: (artifact: SliceRunArtifactSummary) => void;
  className?: string;
}

function artifactTypeBadge(type: string | null): { label: string; color: string } {
  if (!type) return { label: 'artifact', color: 'rgba(255,255,255,0.4)' };
  const lower = type.toLowerCase();
  if (lower.includes('code') || lower.includes('pr')) return { label: 'code', color: colors.lime };
  if (lower.includes('doc') || lower.includes('spec')) return { label: 'doc', color: colors.teal };
  if (lower.includes('design')) return { label: 'design', color: colors.iris };
  if (lower.includes('test')) return { label: 'test', color: colors.cyan };
  return { label: type.slice(0, 12), color: 'rgba(255,255,255,0.5)' };
}

export function ArtifactGallery({ artifacts, onOpenArtifact, className }: ArtifactGalleryProps) {
  if (artifacts.length === 0) return null;

  return (
    <div className={className}>
      <div className="flex items-center gap-2 mb-3">
        <span className="section-kicker font-semibold">Artifacts</span>
        <span className="chip text-micro">{artifacts.length}</span>
      </div>
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
        initial="hidden"
        animate="visible"
        variants={{ visible: { transition: { staggerChildren: 0.04 } } }}
      >
        {artifacts.map((artifact, i) => {
          const badge = artifactTypeBadge(artifact.type);
          return (
            <motion.button
              key={artifact.id ?? `artifact-${i}`}
              type="button"
              onClick={() => onOpenArtifact?.(artifact)}
              className="subsection-shell rounded-xl px-3.5 py-3 text-left hover-lift"
              variants={listItemVariants}
              custom={i}
            >
              <div className="flex items-center gap-2">
                <span
                  className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest"
                  style={{
                    color: badge.color,
                    backgroundColor: `${badge.color}18`,
                    border: `1px solid ${badge.color}30`,
                  }}
                >
                  {badge.label}
                </span>
              </div>
              <p className="mt-1.5 text-body font-medium text-white truncate">
                {artifact.title}
              </p>
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
