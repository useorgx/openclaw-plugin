import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AgentAvatar } from '@/components/agents/AgentAvatar';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import type { AgentOption } from './chatTypes';

interface AgentPickerPopoverProps {
  open: boolean;
  mode: 'assignee' | 'watcher';
  agents: AgentOption[];
  quickAgents: AgentOption[];
  query: string;
  selectedAssigneeId: string;
  selectedWatcherIds: string[];
  onQueryChange: (query: string) => void;
  onSelectAssignee: (id: string) => void;
  onToggleWatcher: (id: string) => void;
  onClose: () => void;
  onSwitchMode: (mode: 'assignee' | 'watcher') => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}

export function AgentPickerPopover({
  open,
  mode,
  agents,
  quickAgents,
  query,
  selectedAssigneeId,
  selectedWatcherIds,
  onQueryChange,
  onSelectAssignee,
  onToggleWatcher,
  onClose,
  onSwitchMode,
  anchorRef,
}: AgentPickerPopoverProps) {
  const prefersReducedMotion = useReducedMotion();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.95, y: 8 }}
          animate={prefersReducedMotion ? {} : { opacity: 1, scale: 1, y: 0 }}
          exit={prefersReducedMotion ? {} : { opacity: 0, scale: 0.95, y: 8 }}
          transition={
            prefersReducedMotion
              ? undefined
              : motionTokens.easingBounce
          }
          className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-[320px] rounded-xl border border-white/[0.14] bg-[#0A0E16]/98 p-2.5 shadow-[0_20px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        >
          {/* Caret pointing down */}
          <div
            className="absolute -bottom-[6px] left-4 h-0 w-0 border-l-[6px] border-r-[6px] border-t-[6px] border-l-transparent border-r-transparent border-t-white/[0.14]"
            aria-hidden
          />

          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => onSwitchMode('assignee')}
                className={cn(
                  'rounded-full px-2 py-0.5 text-micro',
                  mode === 'assignee'
                    ? 'bg-white/[0.1] text-primary'
                    : 'text-secondary hover:text-primary'
                )}
              >
                Assignee
              </button>
              <button
                type="button"
                onClick={() => onSwitchMode('watcher')}
                className={cn(
                  'rounded-full px-2 py-0.5 text-micro',
                  mode === 'watcher'
                    ? 'bg-white/[0.1] text-primary'
                    : 'text-secondary hover:text-primary'
                )}
              >
                Watchers
              </button>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded-full border border-white/[0.12] bg-white/[0.03] px-2 text-micro text-secondary hover:bg-white/[0.08] hover:text-primary"
            >
              Close
            </button>
          </div>

          {/* Quick avatar rail */}
          {quickAgents.length > 0 && mode === 'assignee' && (
            <div className="mb-2 flex items-center gap-1.5 overflow-x-auto border-b border-white/[0.06] pb-2 scrollbar-none">
              {quickAgents.map((agent) => {
                const isAssignee = selectedAssigneeId === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => onSelectAssignee(agent.id)}
                    title={agent.name}
                    className={cn(
                      'flex-shrink-0 rounded-full p-0.5 transition-all duration-[120ms]',
                      isAssignee
                        ? 'ring-2 ring-lime/60 ring-offset-1 ring-offset-[#0A0E16]'
                        : 'ring-1 ring-white/[0.12] hover:ring-white/[0.24]'
                    )}
                    aria-pressed={isAssignee}
                    aria-label={`Select ${agent.name} as assignee`}
                  >
                    <AgentAvatar name={agent.name} hint={agent.name} size="xs" />
                  </button>
                );
              })}
            </div>
          )}

          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search agents..."
            className="mb-2 h-9 w-full rounded-lg border border-white/[0.12] bg-black/35 px-2.5 text-caption text-primary outline-none focus:border-lime/35"
            autoFocus
          />

          <div className="max-h-[240px] space-y-1 overflow-y-auto">
            {agents.map((agent) => {
              const isAssignee = selectedAssigneeId === agent.id;
              const isWatcher = selectedWatcherIds.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    if (mode === 'assignee') {
                      onSelectAssignee(agent.id);
                      return;
                    }
                    if (isAssignee) return;
                    onToggleWatcher(agent.id);
                  }}
                  className={cn(
                    'flex min-h-[38px] w-full items-center justify-between rounded-lg border px-2 py-1.5 text-left text-caption',
                    isAssignee
                      ? 'border-lime/30 bg-lime/[0.12] text-[#E1FFB2]'
                      : isWatcher
                        ? 'border-teal/30 bg-teal/[0.12] text-teal-100'
                        : 'border-white/[0.1] bg-white/[0.02] text-secondary hover:bg-white/[0.08] hover:text-primary'
                  )}
                >
                  <span className="inline-flex items-center gap-2">
                    <AgentAvatar name={agent.name} hint={agent.name} size="xs" />
                    <span>{agent.name}</span>
                  </span>
                  <span className="text-micro">
                    {isAssignee ? 'Assignee' : isWatcher ? 'Watcher' : 'Select'}
                  </span>
                </button>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
