import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/time';

interface ConversationMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  senderName?: string | null;
  content: string;
  timestamp?: string | null;
}

interface ConversationThreadProps {
  messages: ConversationMessage[];
  isAgentRunning?: boolean;
  className?: string;
}

export function ConversationThread({
  messages,
  isAgentRunning,
  className,
}: ConversationThreadProps) {
  return (
    <div className={cn('space-y-3', className)}>
      {messages.map((msg) => {
        if (msg.role === 'system') {
          return (
            <div key={msg.id} className="flex justify-center">
              <p className="text-caption text-muted italic max-w-[80%] text-center">
                {msg.content}
              </p>
            </div>
          );
        }

        const isUser = msg.role === 'user';

        return (
          <div
            key={msg.id}
            className={cn('flex', isUser ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] px-3.5 py-2.5',
                isUser
                  ? 'surface-tier-2 rounded-2xl rounded-br-sm border border-lime/[0.16]'
                  : 'glass-panel rounded-2xl rounded-bl-sm'
              )}
            >
              {msg.senderName && (
                <p className="text-micro text-muted mb-1">{msg.senderName}</p>
              )}
              <p className="text-body text-primary leading-relaxed whitespace-pre-wrap break-words">
                {msg.content}
              </p>
              {msg.timestamp && (
                <p className="mt-1 text-micro text-muted tabular-nums text-right">
                  {formatRelativeTime(msg.timestamp)}
                </p>
              )}
            </div>
          </div>
        );
      })}

      {isAgentRunning && (
        <div className="flex justify-start">
          <div className="glass-panel rounded-2xl rounded-bl-sm px-4 py-3">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-lime/60 pulse-soft" />
              <span className="h-1.5 w-1.5 rounded-full bg-lime/60 pulse-soft" style={{ animationDelay: '0.3s' }} />
              <span className="h-1.5 w-1.5 rounded-full bg-lime/60 pulse-soft" style={{ animationDelay: '0.6s' }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
