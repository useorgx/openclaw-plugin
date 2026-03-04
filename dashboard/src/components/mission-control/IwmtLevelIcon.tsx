import type { MissionControlNodeType } from '@/types';
import { colors } from '@/lib/tokens';
import { WorkstreamGlyph } from '@/components/shared/WorkstreamGlyph';

type IwmtLevel = MissionControlNodeType;

interface IwmtLevelIconProps {
  level: IwmtLevel;
  size?: number;
  className?: string;
}

export function IwmtLevelIcon({ level, size = 12, className = '' }: IwmtLevelIconProps) {
  if (level === 'initiative') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        stroke={colors.iris}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" fill="rgba(124,124,255,0.14)" />
        <circle cx="12" cy="12" r="4.5" />
        <circle cx="12" cy="12" r="1.6" fill={colors.iris} stroke="none" />
      </svg>
    );
  }

  if (level === 'workstream') {
    return (
      <WorkstreamGlyph
        size={size}
        className={className}
        stroke={colors.lime}
        strokeWidth={1.9}
        withBackground
        backgroundColor="rgba(191,255,0,0.12)"
      />
    );
  }

  if (level === 'milestone') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        stroke={colors.teal}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 5v14" />
        <path d="m7 6 10 1.1-1.8 3.5L17 14 7 12.9z" fill="rgba(20,184,166,0.12)" />
        <circle cx="7" cy="5" r="1.2" fill={colors.teal} stroke="none" />
      </svg>
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="rgba(255,255,255,0.72)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4.5" y="4.5" width="15" height="15" rx="4" fill="rgba(255,255,255,0.1)" />
      <path d="M9 12.2 11.1 14.3 15.2 10.1" />
    </svg>
  );
}

export function iwmtLevelCode(level: IwmtLevel): 'I' | 'W' | 'M' | 'T' {
  if (level === 'initiative') return 'I';
  if (level === 'workstream') return 'W';
  if (level === 'milestone') return 'M';
  return 'T';
}
