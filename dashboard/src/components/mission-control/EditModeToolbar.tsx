interface EditModeToolbarProps {
  editMode: boolean;
  onToggleEditMode: () => void;
}

export function EditModeToolbar({ editMode, onToggleEditMode }: EditModeToolbarProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-2.5">
      <div className="text-[11px] text-white/45">
        {editMode
          ? 'Edit mode enabled: status, priority, ETA, duration, dependencies, assignments'
          : 'Read mode: click rows to drill in and inspect dependency paths'}
      </div>
      <button
        type="button"
        onClick={onToggleEditMode}
        className={`rounded-md border px-3 py-1.5 text-[11px] transition-colors ${
          editMode
            ? 'border-[#BFFF00]/30 bg-[#BFFF00]/15 text-[#D8FFA1]'
            : 'border-white/[0.12] bg-white/[0.05] text-white/65 hover:bg-white/[0.1]'
        }`}
      >
        {editMode ? 'Exit edit mode' : 'Edit mode'}
      </button>
    </div>
  );
}

