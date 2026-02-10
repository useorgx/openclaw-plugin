interface EditModeToolbarProps {
  editMode: boolean;
  onToggleEditMode: () => void;
}

export function EditModeToolbar({ editMode, onToggleEditMode }: EditModeToolbarProps) {
  return (
    <div className="flex items-center justify-end">
      <button
        type="button"
        onClick={onToggleEditMode}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-colors ${
          editMode
            ? 'bg-[#BFFF00]/12 text-[#D8FFA1]'
            : 'text-white/40 hover:text-white/65 hover:bg-white/[0.04]'
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
        {editMode ? 'Editing' : 'Edit'}
      </button>
    </div>
  );
}

