import { getAgentColor, getInitials } from '@/lib/tokens';

interface AgentAvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md';
}

const sizeMap = {
  xs: 'w-6 h-6 text-[9px]',
  sm: 'w-8 h-8 text-[10px]',
  md: 'w-10 h-10 text-[12px]',
};

export function AgentAvatar({ name, size = 'xs' }: AgentAvatarProps) {
  const color = getAgentColor(name);

  return (
    <div
      className={`${sizeMap[size]} rounded-full flex items-center justify-center font-semibold flex-shrink-0`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
        border: `1px solid ${color}30`,
      }}
    >
      {getInitials(name)}
    </div>
  );
}
