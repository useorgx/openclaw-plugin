import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface MarkdownTextProps {
  text: string;
  mode?: 'inline' | 'block';
  className?: string;
}

const INLINE_TOKEN =
  /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;
  INLINE_TOKEN.lastIndex = 0;

  for (let match = INLINE_TOKEN.exec(text); match; match = INLINE_TOKEN.exec(text)) {
    const [full] = match;
    const start = match.index;

    if (start > cursor) {
      nodes.push(text.slice(cursor, start));
    }

    const key = `${keyPrefix}-${tokenIndex++}`;
    const linkLabel = match[1];
    const linkUrl = match[2];
    const inlineCode = match[3];
    const strongA = match[4];
    const strongB = match[5];
    const emA = match[6];
    const emB = match[7];

    if (linkLabel && linkUrl && isSafeUrl(linkUrl)) {
      nodes.push(
        <a
          key={key}
          href={linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#D8FFA1] underline decoration-white/35 underline-offset-2 transition hover:text-[#ECFFC6]"
        >
          {linkLabel}
        </a>
      );
    } else if (inlineCode) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-white/[0.08] px-1 py-0.5 font-mono text-[0.93em] text-white/95"
        >
          {inlineCode}
        </code>
      );
    } else if (strongA || strongB) {
      nodes.push(
        <strong key={key} className="font-semibold text-white">
          {strongA ?? strongB}
        </strong>
      );
    } else if (emA || emB) {
      nodes.push(
        <em key={key} className="italic text-white/90">
          {emA ?? emB}
        </em>
      );
    } else {
      nodes.push(full);
    }

    cursor = start + full.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function renderInlineMultiline(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  lines.forEach((line, index) => {
    nodes.push(...renderInline(line, `${keyPrefix}-line-${index}`));
    if (index < lines.length - 1) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
    }
  });
  return nodes;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const current = lines[index] ?? '';
    const trimmed = current.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;

      blocks.push(
        <div key={`code-${index}`} className="rounded-xl border border-white/[0.1] bg-black/40 p-3">
          {lang && <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-white/35">{lang}</p>}
          <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-white/78">
            <code>{codeLines.join('\n')}</code>
          </pre>
        </div>
      );
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = headingMatch[2];
      const sizeClass =
        level === 1 ? 'text-[16px] font-semibold' : level === 2 ? 'text-[14px] font-semibold' : 'text-[13px] font-medium';
      blocks.push(
        <p key={`h-${index}`} className={cn('tracking-[-0.01em] text-white', sizeClass)}>
          {renderInline(headingText, `h-${index}`)}
        </p>
      );
      index += 1;
      continue;
    }

    const bulletMatch = current.match(/^\s*[-*]\s+(.+)$/);
    if (bulletMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const line = lines[index] ?? '';
        const liMatch = line.match(/^\s*[-*]\s+(.+)$/);
        if (!liMatch) break;
        items.push(liMatch[1]);
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${index}`} className="space-y-1.5 pl-4">
          {items.map((item, itemIndex) => (
            <li key={`ul-${index}-${itemIndex}`} className="list-disc text-[13px] leading-relaxed text-white/78">
              {renderInline(item, `ul-${index}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    const numberedMatch = current.match(/^\s*\d+\.\s+(.+)$/);
    if (numberedMatch) {
      const items: string[] = [];
      while (index < lines.length) {
        const line = lines[index] ?? '';
        const liMatch = line.match(/^\s*\d+\.\s+(.+)$/);
        if (!liMatch) break;
        items.push(liMatch[1]);
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${index}`} className="space-y-1.5 pl-4">
          {items.map((item, itemIndex) => (
            <li key={`ol-${index}-${itemIndex}`} className="list-decimal text-[13px] leading-relaxed text-white/78">
              {renderInline(item, `ol-${index}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index] ?? '';
      const lineTrimmed = line.trim();
      if (!lineTrimmed) break;
      if (/^(#{1,3})\s+/.test(lineTrimmed)) break;
      if (/^\s*[-*]\s+/.test(line)) break;
      if (/^\s*\d+\.\s+/.test(line)) break;
      if (lineTrimmed.startsWith('```')) break;
      paragraphLines.push(line);
      index += 1;
    }

    blocks.push(
      <p key={`p-${index}`} className="text-[13px] leading-relaxed text-white/78">
        {renderInlineMultiline(paragraphLines.join('\n'), `p-${index}`)}
      </p>
    );
  }

  return blocks;
}

export function MarkdownText({ text, mode = 'inline', className }: MarkdownTextProps) {
  const value = text.replace(/\r\n/g, '\n');
  if (!value.trim()) return null;

  if (mode === 'inline') {
    return (
      <span className={className}>
        {renderInline(value, 'inline')}
      </span>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      {renderBlocks(value)}
    </div>
  );
}
