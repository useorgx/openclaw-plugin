import type { ReactNode } from 'react';
import { EntityIcon, type EntityIconType } from '@/components/shared/EntityIcon';

interface Breadcrumb {
  label: string;
  onClick?: () => void;
}

interface ModalShellProps {
  breadcrumbs: Breadcrumb[];
  typeBadge?: { label: string; icon?: EntityIconType };
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}

export function ModalShell({
  breadcrumbs,
  typeBadge,
  onClose,
  footer,
  children,
}: ModalShellProps) {
  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      {/* Header with breadcrumb + close button */}
      <div className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-3 sm:px-6">
        <div className="flex items-center gap-1.5 min-w-0 text-body text-secondary">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1.5 min-w-0">
              {i > 0 && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-faint">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              )}
              {crumb.onClick ? (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className={`truncate transition-colors hover:text-primary ${i === breadcrumbs.length - 1 ? 'text-primary font-medium' : ''}`}
                >
                  {crumb.label}
                </button>
              ) : (
                <span className={`truncate ${i === breadcrumbs.length - 1 ? 'text-primary font-medium' : ''}`}>
                  {crumb.label}
                </span>
              )}
            </span>
          ))}
          {typeBadge && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-white/[0.1] bg-white/[0.04] px-2 py-0.5 text-micro uppercase tracking-[0.06em] text-secondary">
              {typeBadge.icon && <EntityIcon type={typeBadge.icon} size={11} className="opacity-90" />}
              {typeBadge.label}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border border-strong bg-white/[0.03] text-primary transition-colors hover:bg-white/[0.08] hover:text-white"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6L6 18" />
            <path d="M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {children}
      </div>

      {/* Optional sticky footer */}
      {footer && (
        <div className="flex-shrink-0 border-t border-subtle px-5 py-3 sm:px-6">
          {footer}
        </div>
      )}
    </div>
  );
}
