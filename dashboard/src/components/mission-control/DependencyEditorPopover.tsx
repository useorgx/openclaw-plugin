import { useMemo, useState } from 'react';

interface DependencyEditorPopoverProps {
  dependencies: string[];
  allNodes: Array<{ id: string; title: string }>;
  disabled?: boolean;
  onSave: (dependencyIds: string[]) => void;
}

export function DependencyEditorPopover({
  dependencies,
  allNodes,
  disabled = false,
  onSave,
}: DependencyEditorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(dependencies.join(', '));

  const hints = useMemo(
    () =>
      allNodes
        .slice(0, 12)
        .map((node) => `${node.id.slice(0, 8)}… ${node.title}`),
    [allNodes]
  );

  const save = () => {
    const parsed = draft
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    onSave(Array.from(new Set(parsed)));
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(dependencies.join(', '));
          setOpen((prev) => !prev);
        }}
        className="rounded-md border border-white/[0.12] bg-white/[0.04] px-2 py-1 text-[10px] text-white/70 hover:bg-white/[0.08] disabled:opacity-40"
      >
        {dependencies.length > 0 ? `${dependencies.length} linked` : 'Set links'}
      </button>

      {open && (
        <div className="absolute right-0 z-20 mt-1.5 w-[300px] rounded-xl border border-white/[0.14] bg-[#0A0D14] p-2.5 shadow-[0_20px_40px_rgba(0,0,0,0.45)]">
          <label className="text-[10px] uppercase tracking-[0.08em] text-white/40">
            Dependency IDs (comma separated)
          </label>
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="mt-1.5 h-[72px] w-full resize-none rounded-md border border-white/[0.12] bg-white/[0.04] px-2 py-1.5 text-[11px] text-white/80 outline-none focus:border-[#BFFF00]/40"
          />
          <div className="mt-2 rounded-md border border-white/[0.08] bg-white/[0.02] p-1.5 text-[10px] text-white/45">
            IDs: {hints.join(' • ')}
          </div>
          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-white/[0.12] px-2 py-1 text-[10px] text-white/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-2 py-1 text-[10px] text-[#D8FFA1]"
            >
              Save links
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

