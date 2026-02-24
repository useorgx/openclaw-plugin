import { useEffect, useRef } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motion as motionTokens } from '@/lib/tokens';
import { formatRelativeTime } from '@/lib/time';
import type { InlineMessage } from './chatTypes';

interface InlineResponseProps {
  messages: InlineMessage[];
  isStreaming: boolean;
  collapsed: boolean;
  onClick?: () => void;
}

export function InlineResponse({ messages, isStreaming, collapsed, onClick }: InlineResponseProps) {
  const prefersReducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, messages[messages.length - 1]?.body]);

  const displayed = collapsed ? messages.slice(-2) : messages;

  if (displayed.length === 0) return null;

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, height: 0 }}
      animate={prefersReducedMotion ? {} : { opacity: 1, height: 'auto' }}
      exit={prefersReducedMotion ? {} : { opacity: 0, height: 0 }}
      transition={
        prefersReducedMotion
          ? undefined
          : {
              duration: motionTokens.durationStandard / 1000,
              ease: motionTokens.easingStandard as unknown as number[],
            }
      }
      className="overflow-hidden"
    >
      <div
        ref={scrollRef}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        className={cn(
          'max-h-[200px] space-y-1.5 overflow-y-auto px-1 pb-2 pt-1',
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
                  : {
                      opacity: 0,
                      x: msg.role === 'user' ? 12 : -12,
                    }
              }
              animate={prefersReducedMotion ? {} : { opacity: 1, x: 0 }}
              transition={
                prefersReducedMotion
                  ? undefined
                  : {
                      duration: motionTokens.durationStandard / 1000,
                      ease: motionTokens.easingStandard as unknown as number[],
                    }
              }
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
                    'max-w-[85%] rounded-xl border px-2.5 py-1.5',
                    msg.role === 'user' && 'border-lime/25 bg-lime/[0.1]',
                    msg.role === 'agent' && 'border-teal/25 bg-teal/[0.1]',
                    msg.role === 'error' && 'border-rose-400/30 bg-rose-400/[0.12]'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'text-micro font-medium',
                        msg.role === 'user' && 'text-[#E1FFB2]',
                        msg.role === 'agent' && 'text-teal-100',
                        msg.role === 'error' && 'text-rose-100'
                      )}
                    >
                      {msg.role === 'user' ? 'You' : msg.role === 'error' ? 'Error' : 'Agent'}
                    </span>
                    <time className="text-[10px] text-muted" dateTime={msg.timestamp}>
                      {formatRelativeTime(msg.timestamp)}
                    </time>
                  </div>
                  <p
                    className={cn(
                      'mt-0.5 whitespace-pre-wrap text-caption',
                      msg.role === 'user' && 'text-primary',
                      msg.role === 'agent' && 'text-primary',
                      msg.role === 'error' && 'text-rose-100'
                    )}
                  >
                    {msg.body}
                    {isStreaming && msg === displayed[displayed.length - 1] && msg.role === 'agent' && (
                      <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-teal-200" />
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
