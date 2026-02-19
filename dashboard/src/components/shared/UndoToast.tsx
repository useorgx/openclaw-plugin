import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { colors } from '@/lib/tokens';

interface UndoToastProps {
  message: string;
  durationMs?: number;
  onUndo: () => void;
  onExpire: () => void;
}

export function UndoToast({ message, durationMs = 5000, onUndo, onExpire }: UndoToastProps) {
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      setVisible(false);
      onExpire();
    }, durationMs);
    return () => clearTimeout(timerRef.current);
  }, [durationMs, onExpire]);

  const handleUndo = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
    onUndo();
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.95 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
        >
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-2.5 shadow-lg"
            style={{
              backgroundColor: colors.cardBgElevated,
              border: `1px solid ${colors.cardBorderStrong}`,
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.lime}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
            <span className="text-body text-primary">{message}</span>
            <button
              onClick={handleUndo}
              className="ml-1 rounded-md px-2.5 py-1 text-caption font-semibold transition-colors hover:bg-white/[0.08]"
              style={{ color: colors.lime }}
            >
              Undo
            </button>
            {/* Countdown bar */}
            <div className="absolute bottom-0 left-3 right-3 h-0.5 overflow-hidden rounded-full">
              <div
                className="h-full origin-left rounded-full"
                style={{
                  backgroundColor: colors.lime,
                  opacity: 0.4,
                  animation: `undoCountdown ${durationMs}ms linear forwards`,
                }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Manager: queue multiple toasts ─────────────────────────────── */

interface UndoItem {
  id: string;
  message: string;
  onUndo: () => void;
  onCommit: () => void;
}

export function useUndoToast() {
  const [queue, setQueue] = useState<UndoItem[]>([]);

  const enqueue = (item: Omit<UndoItem, 'id'>) => {
    const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setQueue((prev) => [...prev, { ...item, id }]);
    return id;
  };

  const remove = (id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  };

  const current = queue[0] ?? null;

  const ToastRenderer = () =>
    current ? (
      <UndoToast
        key={current.id}
        message={current.message}
        onUndo={() => {
          current.onUndo();
          remove(current.id);
        }}
        onExpire={() => {
          current.onCommit();
          remove(current.id);
        }}
      />
    ) : null;

  return { enqueue, ToastRenderer };
}
