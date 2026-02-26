import type { ReactNode } from 'react';
import { ModalShell } from '@/components/shared/ModalShell';

interface ActivityDetailModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ActivityDetailModal({ open, onClose, children }: ActivityDetailModalProps) {
  if (!open) return null;

  return (
    <ModalShell
      breadcrumbs={[]}
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 w-full flex-col">
        {/* Minimal header, close button only */}
        <div className="flex justify-end p-2 absolute top-0 right-0 z-10">
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/[0.06] hover:text-white"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pt-8">
          {children}
        </div>
      </div>
    </ModalShell>
  );
}
