interface WorkstreamGlyphProps {
  size?: number;
  className?: string;
  stroke?: string;
  strokeWidth?: number;
  withBackground?: boolean;
  backgroundColor?: string;
}

/**
 * Canonical workstream glyph used across Mission Control surfaces.
 * Top and bottom lanes cross to imply orchestration flow convergence.
 */
export function WorkstreamGlyph({
  size = 14,
  className = '',
  stroke = 'currentColor',
  strokeWidth = 1.8,
  withBackground = false,
  backgroundColor = 'transparent',
}: WorkstreamGlyphProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeWidth}
    >
      {withBackground ? (
        <rect x="2" y="2" width="20" height="20" rx="6" fill={backgroundColor} stroke="none" />
      ) : null}
      <path d="M6 6c3 0 5 6 8 6" />
      <path d="M6 18c3 0 5-6 8-6" />
      <path d="M6 12h12" />
      <path d="m14 8 4 4-4 4" />
      <circle cx="6" cy="6" r="1.5" fill={stroke} stroke="none" />
      <circle cx="6" cy="12" r="1.5" fill={stroke} stroke="none" />
      <circle cx="6" cy="18" r="1.5" fill={stroke} stroke="none" />
    </svg>
  );
}
