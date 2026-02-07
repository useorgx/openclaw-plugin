import type { MissionControlNodeType } from '@/types';
import { colors } from '@/lib/tokens';

interface LevelIconProps {
  type: MissionControlNodeType;
  className?: string;
}

export function LevelIcon({ type, className = '' }: LevelIconProps) {
  if (type === 'initiative') {
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
        <circle cx="12" cy="12" r="8" />
      </svg>
    );
  }

  if (type === 'workstream') {
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.lime}
        strokeWidth="1.8"
      >
        <rect x="5" y="5" width="14" height="14" rx="2" />
      </svg>
    );
  }

  if (type === 'milestone') {
    return (
      <svg
        className={className}
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke={colors.teal}
        strokeWidth="1.8"
      >
        <path d="M12 4l7 7-7 9-7-9 7-7z" />
      </svg>
    );
  }

  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="rgba(255,255,255,0.72)"
      strokeWidth="1.8"
    >
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

