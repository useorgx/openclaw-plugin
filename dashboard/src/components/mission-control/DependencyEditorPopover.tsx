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
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>(dependencies);

  const nodeById = useMemo(
    () => new Map(allNodes.map((node) => [node.id, node])),
    [allNodes]
  );

  const filteredNodes = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const sorted = [...allNodes].sort((a, b) => a.title.localeCompare(b.title));
    if (!normalized) return sorted.slice(0, 16);
    return sorted
      .filter(
        (node) =>
          node.title.toLowerCase().includes(normalized) ||
          node.id.toLowerCase().includes(normalized)
      )
      .slice(0, 16);
  }, [allNodes, query]);

  const save = () => {
    onSave(Array.from(new Set(selected)));
    setOpen(false);
  };

  const toggleSelected = (id: string) => {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((value) => value !== id) : [...prev, id]
    );
  };

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setQuery('');
          setSelected(dependencies);
          setOpen((prev) => !prev);
        }}
        className="rounded-md border border-white/[0.12] bg-white/[0.04] px-2 py-1 text-[10px] text-white/70 transition-colors hover:bg-white/[0.08] disabled:opacity-40"
      >
        {dependencies.length > 0 ? `${dependencies.length} linked` : 'Set links'}
      </button>

      {open && (
        <div className="surface-tier-2 absolute right-0 z-20 mt-1.5 w-[320px] rounded-xl p-2.5 shadow-[0_20px_40px_rgba(0,0,0,0.45)]">
          <label className="text-[10px] uppercase tracking-[0.08em] text-white/45">
            Link dependencies
          </label>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title or id..."
            className="mt-1.5 h-9 w-full rounded-md border border-white/[0.12] bg-black/25 px-2.5 text-[11px] text-white/85 outline-none transition-colors placeholder:text-white/35 focus:border-[#BFFF00]/35"
          />

          <div className="mt-2 flex max-h-[84px] flex-wrap gap-1.5 overflow-y-auto rounded-md border border-white/[0.08] bg-black/20 p-1.5">
            {selected.length === 0 ? (
              <span className="text-[10px] text-white/40">No links selected</span>
            ) : (
              selected.map((id) => {
                const title = nodeById.get(id)?.title ?? id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleSelected(id)}
                    className="inline-flex items-center gap-1 rounded-full border border-white/[0.16] bg-white/[0.05] px-2 py-0.5 text-[10px] text-white/70 transition-colors hover:bg-white/[0.1]"
                    title={title}
                  >
                    <span className="max-w-[180px] truncate">{title}</span>
                    <span className="text-white/45">×</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="mt-2 max-h-[150px] space-y-1 overflow-y-auto rounded-md border border-white/[0.08] bg-black/20 p-1.5">
            {filteredNodes.length === 0 ? (
              <div className="px-1 text-[10px] text-white/40">No matching nodes</div>
            ) : (
              filteredNodes.map((node) => {
                const checked = selected.includes(node.id);
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => toggleSelected(node.id)}
                    className={`flex w-full items-center justify-between rounded-md border px-2 py-1 text-left text-[10px] transition-colors ${
                      checked
                        ? 'border-[#BFFF00]/32 bg-[#BFFF00]/12 text-[#D8FFA1]'
                        : 'border-white/[0.1] bg-white/[0.03] text-white/70 hover:bg-white/[0.08]'
                    }`}
                  >
                    <span className="min-w-0 pr-2">
                      <span className="block truncate">{node.title}</span>
                      <span className="block truncate text-white/40">{node.id.slice(0, 8)}…</span>
                    </span>
                    <span className="font-semibold">{checked ? 'Linked' : 'Link'}</span>
                  </button>
                );
              })
            )}
          </div>

          <div className="mt-2 flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-white/[0.12] px-2 py-1 text-[10px] text-white/60 transition-colors hover:bg-white/[0.08]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              className="rounded-md border border-[#BFFF00]/30 bg-[#BFFF00]/15 px-2 py-1 text-[10px] text-[#D8FFA1] transition-colors hover:bg-[#BFFF00]/22"
            >
              Save links
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
