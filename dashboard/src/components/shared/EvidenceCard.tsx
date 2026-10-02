import { useState } from 'react';
import { OxReceiptRow } from '@useorgx/orgx-ui-kit/react';

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

/**
 * Confidence -> kit receipt status. High confidence is met (teal); the middle
 * band is the person's call (amber); low or missing confidence is unverified
 * (muted), never "failed": weak evidence is not a failed check.
 */
function receiptStatus(confidence: number | null | undefined): 'met' | 'yours' | 'unverified' {
  if (confidence == null) return 'unverified';
  if (confidence >= 0.8) return 'met';
  if (confidence >= 0.5) return 'yours';
  return 'unverified';
}

function detectUrl(text: string): string | null {
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function displayTypeFallback(evidenceType: string | null | undefined, icon: EvidenceIcon | undefined): string {
  if (evidenceType) return evidenceType;
  if (icon) return icon.toUpperCase();
  return 'Evidence';
}

/**
 * One line of proof (the OrgX kit's <ox-receipt-row>): status, title, type and
 * summary, confidence on the right, and the source as the link. The raw
 * payload and the terminal shortcut stay one click away.
 */
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

  const displayTitle = title ?? label ?? displayTypeFallback(evidenceType, icon);
  const displayType = evidenceType ?? (icon ? icon.toUpperCase() : null);
  const prUrl = icon === 'pr' && label ? detectUrl(label) : null;
  const href = sourceUrl ?? prUrl ?? undefined;
  const hasPayload = Boolean(payload && Object.keys(payload).length > 0);
  const hasTerminal = icon === 'log' && Boolean(onOpenTerminal);
  const detail = [displayType, summary].filter(Boolean).join(' · ');

  return (
    // The row drops its own top rule as a first child; the wrapper carries the hairline.
    <div className="border-t border-ox-border first:border-t-0">
      <OxReceiptRow
        status={receiptStatus(confidence)}
        label={displayTitle}
        detail={detail || undefined}
        value={confidence != null ? `${Math.round(confidence * 100)}%` : undefined}
        href={href}
        target={href ? '_blank' : undefined}
      />
      {hasPayload || hasTerminal ? (
        <div className="pb-2 pl-[30px]">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="text-micro font-semibold text-muted transition-colors hover:text-secondary"
          >
            {expanded ? 'Hide details' : 'Show details'}
          </button>
          {expanded ? (
            <div className="mt-2 space-y-2">
              {hasTerminal && (
                <button
                  type="button"
                  onClick={() => onOpenTerminal?.()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-white/[0.04] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
                >
                  <span className="font-mono text-micro">{'>_'}</span>
                  Open in terminal
                </button>
              )}
              {hasPayload && (
                <pre className="max-h-40 overflow-auto rounded-lg bg-black/40 p-2.5 font-mono text-micro text-secondary">
                  {JSON.stringify(payload, null, 2)}
                </pre>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
