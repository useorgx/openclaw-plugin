import type { MissionControlNodeType } from '@/types';
import { EntityIcon } from '@/components/shared/EntityIcon';

interface LevelIconProps {
  type: MissionControlNodeType;
  className?: string;
}

export function LevelIcon({ type, className = '' }: LevelIconProps) {
  return <EntityIcon type={type} className={className} size={14} />;
}
