import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import type { AgentOption } from './chatTypes';

interface MentionDropdownProps {
  open: boolean;
  agents: AgentOption[];
  query: string;
  activeIndex: number;
  anchorRect: { top: number; left: number } | null;
  onSelect: (agent: AgentOption) => void;
  onClose: () => void;
}

const DROPDOWN_SPRING = { type: 'spring' as const, stiffness: 500, damping: 30, mass: 0.5 };

export function MentionDropdown({
  open,
  agents,
  query,
  activeIndex,
  onSelect,
}: MentionDropdownProps) {
  const prefersReducedMotion = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const filtered = query.length > 0
    ? agents.filter((a) => {
        const q = query.toLowerCase();
        return (
          a.name.toLowerCase().includes(q) ||
          a.handle.toLowerCase().includes(q) ||
          a.domain.toLowerCase().includes(q) ||
          a.role.toLowerCase().includes(q)
        );
      })
    : agents;

  if (!open || filtered.length === 0) return null;

  const displayed = filtered.slice(0, 6);

  return (
    <AnimatePresence>
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: 8, scale: 0.96 }}
        animate={prefersReducedMotion ? {} : { opacity: 1, y: 0, scale: 1 }}
        exit={prefersReducedMotion ? {} : { opacity: 0, y: 8, scale: 0.96 }}
        transition={prefersReducedMotion ? undefined : DROPDOWN_SPRING}
        className={cn(
          'absolute bottom-[calc(100%+6px)] left-0 z-30 w-[280px]',
          'rounded-2xl border border-white/[0.1] bg-[#0D1117]/98 p-1',
          'shadow-[0_16px_48px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur-2xl'
        )}
        role="listbox"
        aria-label="Agent suggestions"
      >
        <div ref={listRef} className="space-y-px">
          {displayed.map((agent, i) => {
            const isActive = i === activeIndex;
            return (
              <button
                key={agent.id}
                type="button"
                role="option"
                aria-selected={isActive}
                data-active={isActive}
                onClick={() => onSelect(agent)}
                onMouseDown={(e) => e.preventDefault()}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left',
                  'transition-colors duration-[60ms]',
                  isActive
                    ? 'bg-white/[0.08] text-primary'
                    : 'text-secondary hover:bg-white/[0.05] hover:text-primary'
                )}
              >
                <AgentAvatar name={agent.name} hint={agent.name} size="xs" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-caption font-medium">{agent.name}</span>
                    {agent.status === 'running' && (
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-lime" aria-label="Running" />
                    )}
                  </div>
                  <span className="text-micro text-muted">{agent.domainLabel}</span>
                </div>
              </button>
            );
          })}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
