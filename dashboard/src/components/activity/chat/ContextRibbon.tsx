import { motion, useReducedMotion } from 'framer-motion';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { cn } from '@/lib/utils';
import type { AgentOption } from './chatTypes';

interface ContextRibbonProps {
  selectedAssignee: AgentOption | null;
  initiativeName: string | null;
  onAgentClick: () => void;
  onScopeClick: () => void;
  agentChipRef: React.RefObject<HTMLButtonElement | null>;
  scopeChipRef: React.RefObject<HTMLButtonElement | null>;
}

export function ContextRibbon({
  selectedAssignee,
  initiativeName,
  onAgentClick,
  onScopeClick,
  agentChipRef,
  scopeChipRef,
}: ContextRibbonProps) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0 }}
      animate={prefersReducedMotion ? {} : { opacity: 1 }}
      transition={
        prefersReducedMotion
          ? undefined
          : { duration: 0.04, delay: 0.04 }
      }
      className="flex items-center gap-2 border-b border-white/[0.06] px-1 pb-2"
    >
      {/* Agent chip */}
      <button
        ref={(node) => { (agentChipRef as React.MutableRefObject<HTMLButtonElement | null>).current = node; }}
        type="button"
        onClick={onAgentClick}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro transition-colors duration-150',
          selectedAssignee
            ? 'border-lime/25 bg-lime/[0.08] text-[#E1FFB2]'
            : 'border-white/[0.12] bg-white/[0.03] text-muted hover:bg-white/[0.08] hover:text-primary'
        )}
      >
        {selectedAssignee ? (
          <>
            <AgentAvatar name={selectedAssignee.name} hint={selectedAssignee.name} size="xs" />
            <span className="max-w-[100px] truncate">{selectedAssignee.name}</span>
          </>
        ) : (
          <span>@ Agent</span>
        )}
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 opacity-50"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <div className="flex-1" />

      {/* Scope chip */}
      <button
        ref={(node) => { (scopeChipRef as React.MutableRefObject<HTMLButtonElement | null>).current = node; }}
        type="button"
        onClick={onScopeClick}
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-micro transition-colors duration-150',
          initiativeName
            ? 'border-cyan/25 bg-cyan/[0.08] text-cyan-100'
            : 'border-white/[0.12] bg-white/[0.03] text-muted hover:bg-white/[0.08] hover:text-primary'
        )}
      >
        <span className="max-w-[140px] truncate">{initiativeName ?? '# Scope'}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 opacity-50"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
    </motion.div>
  );
}
