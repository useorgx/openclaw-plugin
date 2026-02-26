import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/time';
import type { InlineMessage } from './chatTypes';

interface InlineResponseProps {
  messages: InlineMessage[];
  isStreaming: boolean;
  collapsed: boolean;
  onClick?: () => void;
}

const MESSAGE_SPRING = { type: 'spring' as const, stiffness: 500, damping: 35, mass: 0.5 };

export function InlineResponse({ messages, isStreaming, collapsed, onClick }: InlineResponseProps) {
  const prefersReducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Smooth-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, messages[messages.length - 1]?.body]);

  const displayed = collapsed ? messages.slice(-2) : messages;

  if (displayed.length === 0) return null;

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
      animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
      exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
      transition={prefersReducedMotion ? undefined : { duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden"
    >
      <div
        ref={scrollRef}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        className={cn(
          'max-h-[200px] space-y-1.5 overflow-y-auto px-1 pb-2 pt-1',
          'scroll-smooth',
          onClick && 'cursor-pointer'
        )}
      >
        <AnimatePresence initial={false}>
          {displayed.map((msg) => (
            <motion.div
              key={msg.id}
              initial={
                prefersReducedMotion
                  ? false
                  : { opacity: 0, y: 8, scale: 0.97 }
              }
              animate={
                prefersReducedMotion
                  ? {}
                  : { opacity: 1, y: 0, scale: 1 }
              }
              transition={prefersReducedMotion ? undefined : MESSAGE_SPRING}
              className={cn(
                'flex',
                msg.role === 'user' ? 'justify-end' : 'justify-start',
                msg.role === 'system' && 'justify-center'
              )}
            >
              {msg.role === 'system' ? (
                <p className="text-micro italic text-muted">{msg.body}</p>
              ) : (
                <div
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2',
                    msg.role === 'user' && 'bg-lime/[0.1]',
                    msg.role === 'agent' && 'bg-white/[0.05]',
                    msg.role === 'error' && 'bg-rose-400/[0.1]'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'text-micro font-medium',
                        msg.role === 'user' && 'text-[#E1FFB2]/80',
                        msg.role === 'agent' && 'text-secondary',
                        msg.role === 'error' && 'text-rose-200'
                      )}
                    >
                      {msg.role === 'user' ? 'You' : msg.role === 'error' ? 'Error' : 'Agent'}
                    </span>
                    <time className="text-[10px] text-muted/60" dateTime={msg.timestamp}>
                      {formatRelativeTime(msg.timestamp)}
                    </time>
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 whitespace-pre-wrap text-caption leading-relaxed',
                      msg.role === 'user' && 'text-primary',
                      msg.role === 'agent' && 'text-primary',
                      msg.role === 'error' && 'text-rose-100'
                    )}
                  >
                    {msg.body}
                    {isStreaming && msg === displayed[displayed.length - 1] && msg.role === 'agent' && (
                      <span
                        className="ml-0.5 inline-block h-[14px] w-[2px] translate-y-[2px] rounded-full bg-white/50"
                        style={{ animation: 'pulse 1s cubic-bezier(0.4, 0, 0.6, 1) infinite' }}
                      />
                    )}
                  </p>
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
