interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}

export function SearchInput({ value, onChange, placeholder }: SearchInputProps) {
  return (
    <label className="relative block">
      <span className="sr-only">{placeholder}</span>
      <svg
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-white/35"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-white/[0.08] bg-white/[0.03] py-2 pl-9 pr-3 text-[12px] text-white placeholder:text-white/35 transition-all focus:border-white/20 focus:bg-white/[0.05] focus:outline-none"
      />
    </label>
  );
}
