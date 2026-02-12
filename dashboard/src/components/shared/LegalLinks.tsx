import { cn } from '@/lib/utils';

const LEGAL_LINKS = [
  { label: 'Terms', href: 'https://www.useorgx.com/terms' },
  { label: 'Privacy', href: 'https://www.useorgx.com/privacy' },
  { label: 'IP notice', href: 'https://www.useorgx.com/legal' },
];

export function LegalLinks({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-white/35',
        compact ? 'text-[10px]' : 'text-[11px]',
        className
      )}
    >
      <span className="text-white/25">© {new Date().getFullYear()} OrgX</span>
      {LEGAL_LINKS.map((link) => (
        <a
          key={link.label}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="transition-colors hover:text-white/65"
        >
          {link.label}
        </a>
      ))}
    </div>
  );
}
