import { memo, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Initiative, SliceRunProjection } from '@/types';
import { PremiumCard } from '@/components/shared/PremiumCard';
import { EntityIcon } from '@/components/shared/EntityIcon';
import { formatRelativeTime } from '@/lib/time';
import { humanizeId, isOpaqueId, sanitizeDisplayText } from '@/lib/humanize';
import { EmptyState } from '@/components/shared/EmptyState';

interface NeedsInputPanelProps {
  sliceRuns: SliceRunProjection[];
  initiatives?: Initiative[];
  title?: string;
  className?: string;
  showHeader?: boolean;
  panelStyle?: 'card' | 'flat';
  onOpenDecisions?: (decisionId?: string | null) => void;
  onFocusRunId?: (runId: string) => void;
  onReviewActivity?: (sliceRun: SliceRunProjection) => void;
  onOpenSliceDetail?: (sliceRun: SliceRunProjection) => void;
}

const NEEDS_INPUT_STATES = new Set(['awaiting_input', 'needs_review', 'failed']);
const ENVIRONMENT_PATTERNS = [
  /credential/i,
  /api key/i,
  /provider/i,
  /auth/i,
  /token/i,
  /anthropic/i,
  /openai/i,
  /gateway/i,
  /secret/i,
  /permission/i,
];

type NeedsInputCategory = 'decisions' | 'blockers' | 'review' | 'environment';

export interface NeedsInputRow {
  key: string;
  item: SliceRunProjection;
  items: SliceRunProjection[];
  category: NeedsInputCategory;
  duplicateCount: number;
  workstreamCount: number;
  decisionCount: number;
  blockingTaskCount: number;
  artifactCount: number;
  title: string;
  summary: string;
  subtitle: string | null;
  initiativeText: string;
  actionLabel: string;
  scopeText: string | null;
  updatedAt: string | null;
  pendingDecisionId: string | null;
}

interface NeedsInputSection {
  key: NeedsInputCategory;
  label: string;
  description: string;
  rows: NeedsInputRow[];
}

function toEpoch(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactEntityLabel(value: string | null | undefined, prefix: string): string {
  if (!value || value.trim().length === 0) return prefix;
  const trimmed = value.trim();
  return isOpaqueId(trimmed)
    ? `${prefix} ${humanizeId(trimmed)}`
    : trimmed;
}

function summarizeExplainer(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = sanitizeDisplayText(value);
  if (!cleaned || cleaned.length < 10) return null;
  return cleaned.length > 88 ? `${cleaned.slice(0, 85)}…` : cleaned;
}

function normalizeFingerprint(value: string | null | undefined): string {
  const cleaned = sanitizeDisplayText(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return cleaned || 'unknown';
}

function statusLabel(status: SliceRunProjection['status']): string {
  if (status === 'awaiting_input') return 'Needs input';
  if (status === 'needs_review') return 'Needs review';
  if (status === 'failed') return 'Failed';
  return status.replace(/_/g, ' ');
}

function statusTone(status: SliceRunProjection['status']): string {
  if (status === 'failed') return 'border-red-400/30 bg-red-500/[0.10] text-red-100';
  if (status === 'needs_review') return 'border-amber-300/30 bg-amber-300/[0.10] text-amber-100';
  return 'border-lime/30 bg-lime/12 text-lime';
}

function statusHighlight(status: SliceRunProjection['status']): string {
  if (status === 'failed') return 'from-red-300/0 via-red-300/65 to-red-300/0';
  if (status === 'needs_review') return 'from-amber-300/0 via-amber-300/65 to-amber-300/0';
  return 'from-lime/0 via-lime/70 to-lime/0';
}

function resolvePrimaryActionLabel(item: SliceRunProjection): string {
  if (item.primaryAction === 'resolve_decision') return 'Review decision';
  if (item.primaryAction === 'open_artifact') return 'Review output';
  if (item.primaryAction === 'retry_slice') return 'Review blocker';
  if (item.primaryAction === 'review_output') return 'Review output';
  return 'Open details';
}

function isEnvironmentSignal(item: SliceRunProjection): boolean {
  const samples: string[] = [];
  if (item.statusExplainer) samples.push(item.statusExplainer);
  if (item.lastEventSummary) samples.push(item.lastEventSummary);
  for (const blocker of item.blockers ?? []) {
    if (blocker.reason) samples.push(blocker.reason);
    if (blocker.requiredAction) samples.push(blocker.requiredAction);
    if (blocker.waitingOn) samples.push(blocker.waitingOn);
  }
  for (const decision of item.pendingDecisions ?? []) {
    if (decision.title) samples.push(decision.title);
    if (decision.summary) samples.push(decision.summary);
    if (decision.recommendedAction) samples.push(decision.recommendedAction);
  }
  return samples.some((sample) => ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(sample)));
}

function classifyNeedsInputCategory(item: SliceRunProjection): NeedsInputCategory {
  if (isEnvironmentSignal(item)) return 'environment';
  if (item.primaryAction === 'resolve_decision' || item.blockingDecisionCount > 0 || item.decisionCount > 0) {
    return 'decisions';
  }
  if (item.status === 'needs_review' || item.primaryAction === 'review_output' || item.primaryAction === 'open_artifact' || item.artifactCount > 0) {
    return 'review';
  }
  return 'blockers';
}

function deriveClusterKey(item: SliceRunProjection, category: NeedsInputCategory): string {
  const pendingIds = (item.pendingDecisions ?? [])
    .map((decision) => decision.id.trim())
    .filter(Boolean)
    .sort();
  if (pendingIds.length > 0) return `${category}:decision:${pendingIds.join('|')}`;

  const blockerIds = (item.blockers ?? [])
    .map((blocker) => blocker.id.trim())
    .filter(Boolean)
    .sort();
  if (blockerIds.length > 0) return `${category}:blocker:${blockerIds.join('|')}`;

  if (category === 'environment') {
    return `${category}:${normalizeFingerprint(item.statusExplainer || item.lastEventSummary)}`;
  }

  return `${category}:${item.sliceRunId}`;
}

function deriveRepresentativeLabel(
  item: SliceRunProjection,
  preferredLabel: string | null,
  fallbackWorkstreamId: string | null
): string {
  const preferredRaw = preferredLabel?.trim() ?? '';
  if (preferredRaw && !isOpaqueId(preferredRaw)) {
    const safePreferred = sanitizeDisplayText(preferredRaw);
    if (safePreferred && safePreferred !== 'Untitled session') return safePreferred;
  }

  const explainerSummary = summarizeExplainer(item.statusExplainer);
  if (explainerSummary) return explainerSummary;

  if (fallbackWorkstreamId) {
    return compactEntityLabel(fallbackWorkstreamId, 'Workstream');
  }
  return compactEntityLabel(item.sliceRunId, 'Slice');
}

function buildClusterTitle(
  category: NeedsInputCategory,
  representative: SliceRunProjection,
  workstreamLabel: string | null,
  duplicateCount: number
): string {
  const decisionTitle = representative.pendingDecisions?.[0]?.title?.trim() ?? '';
  const blockerReason = representative.blockers?.[0]?.reason?.trim() ?? '';
  const explainer = summarizeExplainer(representative.statusExplainer);

  if (category === 'decisions') {
    return sanitizeDisplayText(decisionTitle || blockerReason || explainer || deriveRepresentativeLabel(representative, workstreamLabel, representative.workstreamId));
  }

  if (category === 'environment') {
    return sanitizeDisplayText(blockerReason || decisionTitle || explainer || 'Environment setup required');
  }

  if (duplicateCount > 1 && (category === 'blockers' || category === 'review')) {
    return sanitizeDisplayText(blockerReason || explainer || deriveRepresentativeLabel(representative, workstreamLabel, representative.workstreamId));
  }

  return sanitizeDisplayText(deriveRepresentativeLabel(representative, workstreamLabel, representative.workstreamId));
}

function buildClusterSummary(row: {
  category: NeedsInputCategory;
  representative: SliceRunProjection;
  duplicateCount: number;
  workstreamCount: number;
  decisionCount: number;
  artifactCount: number;
  blockingTaskCount: number;
}): string {
  const { category, representative, duplicateCount, workstreamCount, decisionCount, artifactCount, blockingTaskCount } = row;
  if (category === 'environment') {
    const targetCount = Math.max(duplicateCount, workstreamCount);
    return `${targetCount} slice${targetCount === 1 ? '' : 's'} are waiting on the same environment or setup issue.`;
  }
  if (category === 'decisions') {
    if (decisionCount > 0) {
      return `${decisionCount} decision${decisionCount === 1 ? '' : 's'} need your judgment before dispatch can continue.`;
    }
    return 'A blocking choice is preventing the next slice from starting.';
  }
  if (category === 'review') {
    if (artifactCount > 0) {
      return `${artifactCount} artifact${artifactCount === 1 ? '' : 's'} are ready for review before the workflow continues.`;
    }
    return 'Output is ready and needs a quick operator pass.';
  }
  if (blockingTaskCount > 0) {
    return `This issue is blocking ${blockingTaskCount} downstream task${blockingTaskCount === 1 ? '' : 's'}.`;
  }
  if (representative.status === 'failed') {
    return 'Execution stopped before the current slice could finish cleanly.';
  }
  return 'This execution slice needs intervention to continue.';
}

function categoryConfig(category: NeedsInputCategory): { label: string; description: string } {
  switch (category) {
    case 'decisions':
      return {
        label: 'Decisions',
        description: 'Judgment calls that determine whether downstream work can proceed.',
      };
    case 'blockers':
      return {
        label: 'Blockers',
        description: 'Execution issues that require retry, intervention, or rerouting.',
      };
    case 'review':
      return {
        label: 'Review-required',
        description: 'Outputs or artifacts that need a quick human pass before continuation.',
      };
    default:
      return {
        label: 'Environment & setup',
        description: 'Credentials, provider setup, or auth issues holding slices open.',
      };
  }
}

export function selectNeedsInputRows(
  sliceRuns: SliceRunProjection[],
  initiatives: Initiative[] = []
): NeedsInputRow[] {
  const filtered = sliceRuns
    .filter((item) => NEEDS_INPUT_STATES.has(item.status))
    .sort((a, b) => toEpoch(b.updatedAt ?? b.lastEventAt ?? '') - toEpoch(a.updatedAt ?? a.lastEventAt ?? ''));

  const initiativeTitleById = new Map<string, string>();
  const workstreamTitleById = new Map<string, string>();
  for (const initiative of initiatives) {
    if (initiative.id) initiativeTitleById.set(initiative.id, initiative.name ?? initiative.id);
    for (const workstream of initiative.workstreams ?? []) {
      if (workstream.id && !workstreamTitleById.has(workstream.id)) {
        workstreamTitleById.set(workstream.id, workstream.name ?? workstream.id);
      }
    }
  }

  const grouped = new Map<string, SliceRunProjection[]>();
  for (const item of filtered) {
    const category = classifyNeedsInputCategory(item);
    const key = deriveClusterKey(item, category);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(item);
    } else {
      grouped.set(key, [item]);
    }
  }

  return Array.from(grouped.entries())
    .map(([key, items]) => {
      const representative = [...items].sort(
        (a, b) => toEpoch(b.updatedAt ?? b.lastEventAt ?? '') - toEpoch(a.updatedAt ?? a.lastEventAt ?? '')
      )[0];
      const category = classifyNeedsInputCategory(representative);
      const initiativeIds = new Set(
        items.flatMap((item) => [
          ...(item.initiativeIds ?? []),
          item.initiativeId ?? '',
        ].filter(Boolean))
      );
      const workstreamIds = new Set(
        items.flatMap((item) => [
          ...(item.workstreamIds ?? []),
          item.workstreamId ?? '',
        ].filter(Boolean))
      );
      const primaryInitiativeId =
        (representative.initiativeIds && representative.initiativeIds[0]) ||
        representative.initiativeId;
      const workstreamLabel =
        representative.workstreamTitle ??
        (representative.workstreamId ? workstreamTitleById.get(representative.workstreamId) ?? null : null);
      const initiativeLabel =
        primaryInitiativeId
          ? initiativeTitleById.get(primaryInitiativeId) ?? compactEntityLabel(primaryInitiativeId, 'Initiative')
          : workstreamIds.size > 1
            ? `${workstreamIds.size} workstreams`
            : compactEntityLabel(representative.workstreamId, 'Workstream');
      const pendingDecisionId = representative.pendingDecisions?.[0]?.id ?? null;
      const decisionCount = items.reduce(
        (sum, item) => sum + Math.max(item.blockingDecisionCount, item.decisionCount),
        0
      );
      const artifactCount = items.reduce((sum, item) => sum + item.artifactCount, 0);
      const blockingTaskCount = items.reduce((sum, item) => sum + (item.blockingDecisionCount ?? 0), 0);
      const duplicateCount = items.length;
      const workstreamCount = workstreamIds.size || duplicateCount;
      const title = buildClusterTitle(category, representative, workstreamLabel, duplicateCount);
      const summary = buildClusterSummary({
        category,
        representative,
        duplicateCount,
        workstreamCount,
        decisionCount,
        artifactCount,
        blockingTaskCount,
      });
      const subtitle =
        duplicateCount > 1
          ? `${workstreamCount} workstream${workstreamCount === 1 ? '' : 's'} · latest ${formatRelativeTime(representative.updatedAt ?? representative.lastEventAt ?? '')}`
          : summarizeExplainer(representative.lastEventSummary) ??
            summarizeExplainer(representative.statusExplainer);
      return {
        key,
        item: representative,
        items,
        category,
        duplicateCount,
        workstreamCount,
        decisionCount,
        blockingTaskCount,
        artifactCount,
        title,
        summary: sanitizeDisplayText(summary),
        subtitle: subtitle ? sanitizeDisplayText(subtitle) : null,
        initiativeText: sanitizeDisplayText(initiativeLabel),
        actionLabel: resolvePrimaryActionLabel(representative),
        scopeText: representative.scope ? representative.scope.replace(/_/g, ' ') : null,
        updatedAt: representative.updatedAt ?? representative.lastEventAt ?? null,
        pendingDecisionId,
      };
    })
    .sort((a, b) => {
      const order: Record<NeedsInputCategory, number> = {
        decisions: 0,
        blockers: 1,
        review: 2,
        environment: 3,
      };
      const categoryDelta = order[a.category] - order[b.category];
      if (categoryDelta !== 0) return categoryDelta;
      return toEpoch(b.updatedAt) - toEpoch(a.updatedAt);
    });
}

function buildSections(rows: NeedsInputRow[]): NeedsInputSection[] {
  const order: NeedsInputCategory[] = ['decisions', 'blockers', 'review', 'environment'];
  return order
    .map((category) => {
      const matches = rows.filter((row) => row.category === category);
      if (matches.length === 0) return null;
      const config = categoryConfig(category);
      return {
        key: category,
        label: config.label,
        description: config.description,
        rows: matches,
      } satisfies NeedsInputSection;
    })
    .filter((section): section is NeedsInputSection => Boolean(section));
}

export const NeedsInputPanel = memo(function NeedsInputPanel({
  sliceRuns,
  initiatives = [],
  title = 'Needs Input',
  className,
  showHeader = true,
  panelStyle = 'card',
  onOpenDecisions,
  onFocusRunId,
  onReviewActivity,
  onOpenSliceDetail,
}: NeedsInputPanelProps) {
  const rows = useMemo(() => selectNeedsInputRows(sliceRuns, initiatives), [sliceRuns, initiatives]);
  const sections = useMemo(() => buildSections(rows), [rows]);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedKeys.has(row.key)),
    [rows, selectedKeys]
  );
  const selectedCategoryCounts = useMemo(() => {
    return selectedRows.reduce<Record<NeedsInputCategory, number>>(
      (counts, row) => {
        counts[row.category] += 1;
        return counts;
      },
      { decisions: 0, blockers: 0, review: 0, environment: 0 }
    );
  }, [selectedRows]);
  const selectedWorkstreamCount = useMemo(() => {
    const workstreamIds = new Set<string>();
    for (const row of selectedRows) {
      for (const item of row.items) {
        const primaryId = item.workstreamId?.trim();
        if (primaryId) workstreamIds.add(primaryId);
        for (const relatedId of item.workstreamIds ?? []) {
          const trimmed = relatedId.trim();
          if (trimmed) workstreamIds.add(trimmed);
        }
      }
    }
    return workstreamIds.size || selectedRows.length;
  }, [selectedRows]);
  const selectedDecisionCount = selectedRows.reduce((sum, row) => sum + row.decisionCount, 0);
  const selectedReviewCount = selectedRows.filter((row) => row.category === 'review').length;
  const selectedCategoryLabels = useMemo(() => {
    return [
      selectedCategoryCounts.decisions > 0
        ? `${selectedCategoryCounts.decisions} decision ${
            selectedCategoryCounts.decisions === 1 ? 'group' : 'groups'
          }`
        : null,
      selectedCategoryCounts.blockers > 0
        ? `${selectedCategoryCounts.blockers} blocker${
            selectedCategoryCounts.blockers === 1 ? '' : 's'
          }`
        : null,
      selectedCategoryCounts.review > 0
        ? `${selectedCategoryCounts.review} review item${
            selectedCategoryCounts.review === 1 ? '' : 's'
          }`
        : null,
      selectedCategoryCounts.environment > 0
        ? `${selectedCategoryCounts.environment} setup issue${
            selectedCategoryCounts.environment === 1 ? '' : 's'
          }`
        : null,
    ].filter((value): value is string => Boolean(value));
  }, [selectedCategoryCounts]);
  const allVisibleSelected = rows.length > 0 && rows.every((row) => selectedKeys.has(row.key));

  const resetSelection = () => {
    setSelectedKeys(new Set());
    setSelectionMode(false);
  };

  const toggleSelection = (rowKey: string) => {
    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedKeys((previous) => {
      if (allVisibleSelected) return new Set();
      return new Set(rows.map((row) => row.key));
    });
  };

  const runPrimaryAction = (row: NeedsInputRow) => {
    const item = row.item;
    if (item.primaryAction === 'resolve_decision') {
      onOpenDecisions?.(row.pendingDecisionId);
      return;
    }
    if (item.primaryAction === 'review_output' || item.primaryAction === 'retry_slice') {
      onReviewActivity?.(item);
      return;
    }
    if (item.primaryAction === 'open_artifact') {
      const firstUrl = item.artifacts.find((artifact) => artifact.url)?.url;
      if (firstUrl && typeof window !== 'undefined') {
        window.open(firstUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      onReviewActivity?.(item);
      return;
    }
    if (item.runId) {
      onFocusRunId?.(item.runId);
      return;
    }
    onOpenSliceDetail?.(item);
  };

  const handleReviewSelected = () => {
    if (selectedRows.length === 0) return;
    if (selectedRows.length === 1) {
      runPrimaryAction(selectedRows[0]);
      return;
    }
    if (selectedDecisionCount > 0) {
      const firstDecisionId = selectedRows.find((row) => row.pendingDecisionId)?.pendingDecisionId ?? null;
      onOpenDecisions?.(firstDecisionId);
      return;
    }
    onOpenSliceDetail?.(selectedRows[0].item);
  };

  return (
    <PremiumCard
      surface={panelStyle === 'card'}
      className={`flex h-full min-h-0 flex-col overflow-hidden ${
        panelStyle === 'flat' ? '!rounded-none !border-none !bg-transparent !shadow-none' : ''
      } ${className ?? ''}`}
    >
      {showHeader ? (
        <div className="flex items-center justify-between gap-2 border-b border-subtle px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-heading font-semibold text-white">{title}</h2>
            <span className="chip text-micro">{rows.length}</span>
          </div>
          {rows.length > 0 ? (
            <div className="flex items-center gap-2">
              {selectionMode ? (
                <>
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="control-pill h-8 px-3 text-caption font-semibold"
                  >
                    {allVisibleSelected ? 'Clear all' : 'Select all'}
                  </button>
                  <button
                    type="button"
                    onClick={resetSelection}
                    className="control-pill h-8 px-3 text-caption font-semibold"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setSelectionMode(true)}
                  className="control-pill h-8 px-3 text-caption font-semibold"
                >
                  Select
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="inbox"
          headline="No slices need attention"
          description="All workstreams are running smoothly. Decisions will appear here when agents need your input."
        />
      ) : (
        <>
          {!showHeader && rows.length > 0 ? (
            <div className="border-b border-subtle px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-micro uppercase tracking-[0.12em] text-white/40">
                    Intervention controls
                  </p>
                  <p className="mt-1 text-caption text-secondary">
                    Group similar issues, then review a focused decision or blocker basket.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {selectionMode ? (
                    <>
                      <button
                        type="button"
                        onClick={handleSelectAll}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                      >
                        {allVisibleSelected ? 'Clear all' : 'Select all'}
                      </button>
                      <button
                        type="button"
                        onClick={resetSelection}
                        className="control-pill h-8 px-3 text-caption font-semibold"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setSelectionMode(true)}
                      className="control-pill h-8 px-3 text-caption font-semibold"
                    >
                      Select
                    </button>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          <div
            className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2 ${
              selectionMode ? 'pb-20' : ''
            }`}
          >
            <AnimatePresence mode="popLayout">
              {sections.map((section) => (
                <motion.section
                  key={section.key}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="rounded-2xl border border-white/[0.06] bg-white/[0.02]"
                >
                  <div className="border-b border-white/[0.06] px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45">
                        {section.label}
                      </p>
                      <span className="rounded-full bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white/55">
                        {section.rows.length}
                      </span>
                    </div>
                    <p className="mt-1 text-caption text-white/35">{section.description}</p>
                  </div>

                  <div className="space-y-2 p-2">
                    {section.rows.map((row, index) => {
                      const isSelected = selectedKeys.has(row.key);
                      return (
                        <motion.article
                          key={row.key}
                          layout
                          initial={{ opacity: 0, y: 8, scale: 0.985 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.97, y: -6 }}
                          transition={{
                            duration: 0.22,
                            delay: Math.min(index, 6) * 0.018,
                            ease: [0.22, 1, 0.36, 1],
                          }}
                          className={`group relative overflow-hidden rounded-2xl border bg-white/[0.02] px-3 py-2.5 transition-colors ${
                            isSelected
                              ? 'border-lime/30 shadow-[0_0_0_1px_rgba(191,255,0,0.12)]'
                              : row.item.status === 'failed'
                                ? 'border-red-400/16 hover:border-red-300/28'
                                : 'border-white/[0.08] hover:border-white/[0.14]'
                          }`}
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            if (selectionMode) {
                              toggleSelection(row.key);
                              return;
                            }
                            onOpenSliceDetail?.(row.item);
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            if (selectionMode) {
                              toggleSelection(row.key);
                              return;
                            }
                            onOpenSliceDetail?.(row.item);
                          }}
                        >
                          <div
                            className={`pointer-events-none absolute inset-x-3 top-0 h-px bg-gradient-to-r ${statusHighlight(row.item.status)}`}
                            aria-hidden
                          />
                          <div className="flex items-start gap-2.5">
                            {selectionMode ? (
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelection(row.key)}
                                onClick={(event) => event.stopPropagation()}
                                className="mt-0.5 h-4 w-4 rounded border-white/20 bg-black/40 text-lime focus:ring-lime/40"
                                aria-label={`Select ${row.title}`}
                              />
                            ) : null}

                            <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="inline-flex min-w-0 items-center gap-1 text-micro uppercase tracking-[0.08em] text-muted">
                                    <EntityIcon type="initiative" size={10} className="flex-shrink-0 opacity-80" />
                                    <span className="truncate">{row.initiativeText}</span>
                                  </p>
                                  <p className="mt-0.5 inline-flex min-w-0 items-start gap-1.5 text-body font-semibold leading-snug text-white" title={row.title}>
                                    <EntityIcon type={row.category === 'decisions' ? 'decision' : 'workstream'} size={12} className="mt-[3px] flex-shrink-0 opacity-90" />
                                    <span className="line-clamp-2">{row.title}</span>
                                  </p>
                                  <p className="mt-1 line-clamp-2 text-caption leading-snug text-secondary" title={row.summary}>
                                    {row.summary}
                                  </p>
                                  {row.subtitle ? (
                                    <p className="mt-1 line-clamp-2 text-micro leading-snug text-muted" title={row.subtitle}>
                                      {row.subtitle}
                                    </p>
                                  ) : null}
                                </div>
                                <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                                  <span
                                    className={`inline-flex h-6 items-center rounded-full border px-2 text-micro font-semibold uppercase tracking-[0.08em] ${statusTone(row.item.status)}`}
                                  >
                                    {statusLabel(row.item.status)}
                                  </span>
                                  {row.scopeText ? (
                                    <span className="chip text-micro capitalize">{row.scopeText}</span>
                                  ) : null}
                                </div>
                              </div>

                              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-micro text-secondary">
                                {row.duplicateCount > 1 ? (
                                  <span className="chip text-micro">
                                    {row.workstreamCount} similar slices
                                  </span>
                                ) : null}
                                {row.blockingTaskCount > 0 ? (
                                  <span className="chip text-micro border-red-400/30 bg-red-500/[0.1] text-red-200/90">
                                    Blocks {row.blockingTaskCount} task{row.blockingTaskCount === 1 ? '' : 's'}
                                  </span>
                                ) : null}
                                {row.decisionCount > 0 ? (
                                  <span className="chip text-micro">
                                    {row.decisionCount} decision{row.decisionCount === 1 ? '' : 's'}
                                  </span>
                                ) : null}
                                {row.artifactCount > 0 ? (
                                  <span className="chip text-micro">
                                    {row.artifactCount} artifact{row.artifactCount === 1 ? '' : 's'}
                                  </span>
                                ) : null}
                                {row.updatedAt ? <span>Updated {formatRelativeTime(row.updatedAt)}</span> : null}
                              </div>

                              {row.item.decisionOptions && row.item.decisionOptions.length > 0 && row.item.decisionOptions.length <= 3 ? (
                                <div className="mt-2 flex flex-wrap gap-1.5" onClick={(event) => event.stopPropagation()}>
                                  {row.item.decisionOptions.slice(0, 3).map((option) => (
                                    <button
                                      key={option.id}
                                      type="button"
                                      onClick={() => onOpenSliceDetail?.(row.item)}
                                      className="chip text-micro font-medium hover:bg-white/[0.08] transition-colors cursor-pointer"
                                      title={option.description ?? option.label}
                                      aria-label={`Review option ${option.label}`}
                                    >
                                      {option.label}
                                    </button>
                                  ))}
                                </div>
                              ) : null}

                              {!selectionMode ? (
                                <div
                                  className="mt-2 flex items-center justify-between gap-2 border-t border-white/[0.07] pt-2"
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    onClick={() => onOpenSliceDetail?.(row.item)}
                                    className="control-pill h-7 px-2.5 text-micro font-semibold"
                                    aria-label={`Open details for ${row.title}`}
                                  >
                                    Details
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => runPrimaryAction(row)}
                                    className="control-pill h-7 px-2.5 text-micro font-semibold"
                                    data-tone={row.item.status === 'failed' ? 'teal' : undefined}
                                    aria-label={`${row.actionLabel} for ${row.title}`}
                                  >
                                    {row.actionLabel}
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </motion.article>
                      );
                    })}
                  </div>
                </motion.section>
              ))}
            </AnimatePresence>
          </div>

          {selectionMode ? (
            <div className="border-t border-subtle bg-black/40 px-3 py-2.5 backdrop-blur-xl">
              <div className="space-y-3">
                <div className="min-w-0 space-y-1">
                  <p className="text-caption font-semibold text-white">
                    {selectedRows.length} selected
                  </p>
                  <p className="text-micro leading-relaxed text-secondary">
                    Review the selected intervention basket before routing the operator to a focused blocker or decision flow.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedCategoryLabels.length > 0 ? (
                    selectedCategoryLabels.map((label) => (
                      <span key={label} className="chip text-micro">
                        {label}
                      </span>
                    ))
                  ) : (
                    <span className="chip text-micro">Review the selected intervention basket</span>
                  )}
                  <span className="chip text-micro">
                    {selectedWorkstreamCount} workstream{selectedWorkstreamCount === 1 ? '' : 's'}
                  </span>
                </div>
                <p className="text-micro leading-relaxed text-white/45">
                  {selectedDecisionCount > 0
                    ? `Routes ${selectedDecisionCount} pending decision${selectedDecisionCount === 1 ? '' : 's'} into the review flow.`
                    : selectedReviewCount > 0
                      ? `Focuses the selected review work across ${selectedWorkstreamCount} workstream${selectedWorkstreamCount === 1 ? '' : 's'}.`
                      : `Focuses the selected intervention basket across ${selectedWorkstreamCount} workstream${selectedWorkstreamCount === 1 ? '' : 's'}.`}
                </p>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedKeys(new Set())}
                    disabled={selectedRows.length === 0}
                    className="control-pill h-9 w-full justify-center px-3 text-caption font-semibold disabled:opacity-40"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={handleReviewSelected}
                    disabled={selectedRows.length === 0}
                    className="control-pill h-9 w-full justify-center px-3 text-caption font-semibold disabled:opacity-40"
                    data-tone={selectedRows.length > 0 ? 'lime' : undefined}
                  >
                    {selectedRows.length <= 1
                      ? 'Open selected'
                      : selectedDecisionCount > 0 && selectedCategoryCounts.decisions === selectedRows.length
                        ? 'Review decision basket'
                        : selectedReviewCount > 0 && selectedCategoryCounts.review === selectedRows.length
                          ? 'Review output basket'
                          : 'Open selected basket'}
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </PremiumCard>
  );
});
