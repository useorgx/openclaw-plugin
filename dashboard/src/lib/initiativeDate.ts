export function daysUntilTargetDate(targetDate: string | null | undefined): number | null {
  if (!targetDate) return null;
  const parsed = Date.parse(targetDate);
  if (!Number.isFinite(parsed)) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const due = new Date(parsed);
  const dueDay = new Date(
    due.getFullYear(),
    due.getMonth(),
    due.getDate()
  ).getTime();

  return Math.round((dueDay - today) / 86_400_000);
}

export type DueBadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

export function formatDueBadge(
  targetDate: string | null | undefined
): { label: string; tone: DueBadgeTone } {
  const days = daysUntilTargetDate(targetDate);
  if (days === null) {
    return { label: 'No target date', tone: 'neutral' };
  }
  if (days < 0) {
    return {
      label: `Overdue ${Math.abs(days)}d`,
      tone: 'danger',
    };
  }
  if (days === 0) {
    return { label: 'Due today', tone: 'warning' };
  }
  if (days <= 7) {
    return { label: `Due in ${days}d`, tone: 'warning' };
  }
  return {
    label: `Due in ${days}d`,
    tone: 'success',
  };
}
