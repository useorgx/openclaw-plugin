import type { HTMLAttributes, ReactNode } from 'react';
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
  return (
    <span
      className={cn(
        'inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-medium leading-none',
        toneClasses[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
