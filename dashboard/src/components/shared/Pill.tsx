import { Children, isValidElement, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

type PillTone = 'neutral' | 'muted' | 'lime' | 'cyan' | 'red';

const toneClasses: Record<PillTone, string> = {
  neutral: 'border-strong bg-white/[0.04] text-primary',
  muted: 'border-strong bg-white/[0.03] text-secondary',
  lime: 'border-lime/28 bg-lime/[0.12] text-[#D8FFA1]',
  cyan: 'border-cyan-300/28 bg-cyan-500/[0.12] text-cyan-100',
  red: 'border-red-300/28 bg-red-500/[0.12] text-red-100',
};

interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  children: ReactNode;
  tone?: PillTone;
}

export function Pill({ children, tone = 'muted', className, ...rest }: PillProps) {
  const hasAgentAvatar = Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false;
    const elementType = child.type as { displayName?: string; name?: string };
    return elementType.displayName === 'AgentAvatar' || elementType.name === 'AgentAvatar';
  });

  return (
    <span
      className={cn(
        'inline-flex h-7 items-center rounded-full border text-caption font-medium leading-none whitespace-nowrap',
        hasAgentAvatar
          ? 'gap-1.5 pl-[3px] pr-2.5 [&>[data-agent-avatar]]:h-5 [&>[data-agent-avatar]]:w-5'
          : 'gap-1.5 px-2.5',
        toneClasses[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
