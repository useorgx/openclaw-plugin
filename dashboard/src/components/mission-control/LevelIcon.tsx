import type { MissionControlNodeType } from '@/types';
import { colors } from '@/lib/tokens';

interface LevelIconProps {
  type: MissionControlNodeType;
  className?: string;
}

export function LevelIcon({ type, className = '' }: LevelIconProps) {
  if (type === 'initiative') {
    // Bullseye — concentric circles with center dot
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.iris}
        strokeWidth="1.8"
      >
        <circle cx="12" cy="12" r="9" fill={`${colors.iris}1A`} />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill={colors.iris} stroke="none" />
      </svg>
    );
  }

  if (type === 'workstream') {
    // Parallel flow lines — 3 horizontal lines with right arrows
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill={`${colors.lime}1A`}
        stroke={colors.lime}
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <rect x="3" y="4" width="18" height="16" rx="3" fill={`${colors.lime}1A`} stroke="none" />
        <line x1="5" y1="8" x2="15" y2="8" />
        <polyline points="15,6 17,8 15,10" fill="none" />
        <line x1="5" y1="12" x2="15" y2="12" />
        <polyline points="15,10 17,12 15,14" fill="none" />
        <line x1="5" y1="16" x2="15" y2="16" />
        <polyline points="15,14 17,16 15,18" fill="none" />
      </svg>
    );
  }

  if (type === 'milestone') {
    // Flag — flag on a pole/post
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.teal}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" fill={`${colors.teal}1A`} />
        <line x1="4" y1="22" x2="4" y2="15" />
      </svg>
    );
  }

  // Task — Checkbox with checkmark
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(255,255,255,0.72)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="4" width="16" height="16" rx="4" fill="rgba(255,255,255,0.10)" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
