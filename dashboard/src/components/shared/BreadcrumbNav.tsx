import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';

interface BreadcrumbSegment {
  label: string;
  icon?: EntityIconType;
  onClick?: () => void;
}

interface BreadcrumbNavProps {
  segments: BreadcrumbSegment[];
}

export function BreadcrumbNav({ segments }: BreadcrumbNavProps) {
  if (segments.length === 0) return null;

  return (
    <nav className="flex items-center gap-1.5 min-w-0 text-caption text-secondary">
      {segments.map((seg, i) => (
        <span key={i} className="flex items-center gap-1.5 min-w-0">
          {i > 0 && (
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="flex-shrink-0 text-faint"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          )}
          {seg.icon && (
            <EntityIcon type={seg.icon} size={11} className="flex-shrink-0 opacity-80" />
          )}
          {seg.onClick ? (
            <button
              type="button"
              onClick={seg.onClick}
              className="truncate transition-colors hover:text-primary"
            >
              {seg.label}
            </button>
          ) : (
            <span className="truncate">{seg.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
