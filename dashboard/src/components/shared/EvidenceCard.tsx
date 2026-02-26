import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type EvidenceIcon = 'pr' | 'file' | 'artifact' | 'log' | 'decision';

export interface EvidenceCardProps {
  // Rich mode (LiveDecisionEvidenceRef fields)
  evidenceType?: string | null;
  title?: string | null;
  summary?: string | null;
  sourceUrl?: string | null;
  confidence?: number | null;
  payload?: Record<string, unknown> | null;
  // Simple mode (triage proof bundle)
  icon?: EvidenceIcon;
  label?: string;
  // Behavior
  onOpenTerminal?: () => void;
}

const ICON_CHARS: Record<EvidenceIcon, string> = {
  pr: '\u238B', // ⎋
  file: '\u25C7', // ◇
  artifact: '\u25AA', // ▪
  log: '\u25B8', // ▸
  decision: '\u25C8', // ◈
};

function confidenceColor(c: number): string {
  if (c >= 0.8) return '#BFFF00'; // lime
  if (c >= 0.5) return '#F5B700'; // amber
  return '#FF6B88'; // red
}

function detectUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

export function EvidenceCard({
  evidenceType,
  title,
  summary,
  sourceUrl,
  confidence,
  payload,
  icon,
  label,
  onOpenTerminal,
}: EvidenceCardProps) {
  const [expanded, setExpanded] = useState(false);

  // Determine display values
  const displayTitle = title ?? label ?? null;
  const displayType = evidenceType ?? (icon ? icon.toUpperCase() : null);
  const iconChar = icon ? ICON_CHARS[icon] : null;

  // For PR refs, detect URL in label
  const prUrl = icon === 'pr' && label ? detectUrl(label) : null;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      <div
        className="flex items-start gap-2.5 cursor-pointer"
        onClick={() => setExpanded((prev) => !prev)}
      >
        {/* Type/icon badge */}
        {(displayType || iconChar) && (
          <span className="mt-0.5 flex-shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-secondary">
            {iconChar ? <span className="mr-1">{iconChar}</span> : null}
            {displayType}
          </span>
        )}

        {/* Title + summary */}
        <div className="min-w-0 flex-1">
          {displayTitle && (
            <p className="text-body font-medium text-primary">
              {sourceUrl ? (
                <a
                  href={sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#D8FFA1] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {displayTitle}
                </a>
              ) : prUrl ? (
                <a
                  href={prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#D8FFA1] hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  {displayTitle}
                </a>
              ) : (
                displayTitle
              )}
            </p>
          )}
          {summary && (
            <p className={`mt-0.5 text-caption text-secondary ${expanded ? '' : 'line-clamp-2'}`}>
              {summary}
            </p>
          )}
        </div>

        {/* Expand chevron */}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`mt-1 flex-shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>

      {/* Confidence bar */}
      {confidence != null && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.round(confidence * 100)}%`,
                backgroundColor: confidenceColor(confidence),
              }}
            />
          </div>
          <span className="text-micro text-muted tabular-nums">{Math.round(confidence * 100)}%</span>
        </div>
      )}

      {/* Expanded content */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2">
              {/* Terminal button for log refs */}
              {icon === 'log' && onOpenTerminal && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenTerminal();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                >
                  <span className="font-mono text-micro">{'>_'}</span>
                  Open in terminal
                </button>
              )}

              {/* Payload JSON block */}
              {payload && Object.keys(payload).length > 0 && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-black/40 p-2.5 text-micro text-secondary font-mono">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
