import type { MissionControlNodeType } from '@/types';
import { EntityIcon } from '@/components/shared/EntityIcon';

interface LevelIconProps {
  type: MissionControlNodeType;
  className?: string;
  /** Optional hierarchy label (e.g. "W1", "M2", "T3") displayed as a compact monospaced badge */
  hierarchyLabel?: string;
}

export function LevelIcon({ type, className = '', hierarchyLabel }: LevelIconProps) {
  return (
    <span className="inline-flex items-center gap-1">
      <EntityIcon type={type} className={className} size={14} />
      {hierarchyLabel && (
        <span
          className="text-[10px] tracking-wider uppercase font-mono tabular-nums opacity-60 hover:opacity-100 transition-opacity leading-none select-none"
          title={hierarchyLabel}
        >
          {hierarchyLabel}
        </span>
      )}
    </span>
  );
}
