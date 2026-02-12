import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

type MarkdownProps = {
  children: string;
  className?: string;
};

export function Markdown({ children, className }: MarkdownProps) {
  const value = String(children ?? '').trim();
  if (!value) return null;

  return (
    <div className={cn('space-y-2 text-[12px] text-white/70', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node, ...props }) => (
            <a
              {...props}
              className={cn(
                'underline underline-offset-2 decoration-white/30 hover:decoration-white/70',
                (props as any)?.className
              )}
              target="_blank"
              rel="noreferrer"
            />
          ),
          code: (rawProps: any) => {
            const {
              inline,
              className: codeClassName,
              children: codeChildren,
              ...props
            } = rawProps ?? {};
            if (inline) {
              return (
                <code
                  {...props}
                  className={cn(
                    'rounded-md border border-white/[0.08] bg-black/30 px-1 py-[2px] font-mono text-[0.92em] text-white/85',
                    codeClassName
                  )}
                >
                  {codeChildren}
                </code>
              );
            }
            return (
              <code {...props} className={cn('font-mono text-[12px] text-white/90', codeClassName)}>
                {codeChildren}
              </code>
            );
          },
          pre: ({ node, className: preClassName, children: preChildren, ...props }) => (
            <pre
              {...props}
              className={cn(
                'overflow-x-auto rounded-xl border border-white/[0.08] bg-black/35 p-3 font-mono text-[12px] text-white/85',
                preClassName
              )}
            >
              {preChildren}
            </pre>
          ),
          ul: ({ node, className: ulClassName, ...props }) => (
            <ul {...props} className={cn('my-2 list-disc pl-5 text-white/70', ulClassName)} />
          ),
          ol: ({ node, className: olClassName, ...props }) => (
            <ol {...props} className={cn('my-2 list-decimal pl-5 text-white/70', olClassName)} />
          ),
          li: ({ node, className: liClassName, ...props }) => (
            <li {...props} className={cn('my-1', liClassName)} />
          ),
          blockquote: ({ node, className: blockClassName, ...props }) => (
            <blockquote
              {...props}
              className={cn(
                'my-3 border-l-2 border-white/15 bg-white/[0.03] px-3 py-2 text-white/70',
                blockClassName
              )}
            />
          ),
          h1: ({ node, className: headingClassName, ...props }) => (
            <h1 {...props} className={cn('text-[15px] font-semibold text-white', headingClassName)} />
          ),
          h2: ({ node, className: headingClassName, ...props }) => (
            <h2 {...props} className={cn('text-[14px] font-semibold text-white', headingClassName)} />
          ),
          h3: ({ node, className: headingClassName, ...props }) => (
            <h3 {...props} className={cn('text-[13px] font-semibold text-white', headingClassName)} />
          ),
          p: ({ node, className: pClassName, ...props }) => (
            <p {...props} className={cn('text-[12px] leading-relaxed text-white/70', pClassName)} />
          ),
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}
