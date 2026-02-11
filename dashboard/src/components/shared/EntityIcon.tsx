import type { MissionControlNodeType } from '@/types';
import { colors } from '@/lib/tokens';
import { WorkstreamGlyph } from '@/components/shared/WorkstreamGlyph';

export type EntityIconType =
  | MissionControlNodeType
  | 'decision'
  | 'notification';

interface EntityIconProps {
  type: EntityIconType;
  className?: string;
  size?: number;
}

export function EntityIcon({ type, className = '', size = 14 }: EntityIconProps) {
  const commonProps = {
    className,
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
  };

  if (type === 'initiative') {
    return (
      <svg {...commonProps} stroke={colors.iris}>
        <circle cx="12" cy="12" r="9" fill={`${colors.iris}1A`} />
        <circle cx="12" cy="12" r="5" />
        <circle cx="12" cy="12" r="1.5" fill={colors.iris} stroke="none" />
      </svg>
    );
  }

  if (type === 'workstream') {
    return (
      <WorkstreamGlyph
        size={size}
        className={className}
        stroke={colors.lime}
        strokeWidth={commonProps.strokeWidth}
        withBackground
        backgroundColor={`${colors.lime}1A`}
      />
    );
  }

  if (type === 'milestone') {
    return (
      <svg {...commonProps} stroke={colors.teal}>
        <path d="M5 3v18" />
        <path d="m5 4 12 1-2 4 2 4-12-1z" fill={`${colors.teal}1A`} />
      </svg>
    );
  }

  if (type === 'task') {
    return (
      <svg {...commonProps} stroke="rgba(255,255,255,0.76)">
        <rect x="4" y="4" width="16" height="16" rx="4" fill="rgba(255,255,255,0.12)" />
        <path d="M9 12.2 11 14.2 15.2 10" />
      </svg>
    );
  }

  if (type === 'decision') {
    return (
      <svg {...commonProps} stroke={colors.amber}>
        <path d="M12 3 5.2 6.1v5.7c0 4.8 3.2 7.5 6.8 9 3.6-1.5 6.8-4.2 6.8-9V6.1z" fill={`${colors.amber}1A`} />
        <path d="m9.3 12.1 1.8 1.9 3.6-3.6" />
      </svg>
    );
  }

  return (
    <svg {...commonProps} stroke={colors.cyan}>
      <path d="M12 3a6 6 0 0 0-6 6v2.9c0 .7-.3 1.4-.8 1.9L4 15.2h16l-1.2-1.4a2.8 2.8 0 0 1-.8-1.9V9a6 6 0 0 0-6-6z" fill={`${colors.cyan}1A`} />
      <path d="M9.2 18a2.8 2.8 0 0 0 5.6 0" />
    </svg>
  );
}
