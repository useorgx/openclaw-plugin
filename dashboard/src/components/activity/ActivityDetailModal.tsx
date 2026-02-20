import type { ReactNode } from 'react';
import { Modal } from '@/components/shared/Modal';

interface ActivityDetailModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function ActivityDetailModal({ open, onClose, children }: ActivityDetailModalProps) {
  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-3xl">
      {children}
    </Modal>
  );
}
