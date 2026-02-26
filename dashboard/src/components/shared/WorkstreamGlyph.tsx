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
      <path d="M6 6.5h3l6.5 11" />
      <path d="M6 17.5h3l6.5-11" />
      <path d="M6 12h9.5" />
      <circle cx="6" cy="6.5" r="1.5" fill={stroke} stroke="none" />
      <circle cx="6" cy="12" r="1.5" fill={stroke} stroke="none" />
      <circle cx="6" cy="17.5" r="1.5" fill={stroke} stroke="none" />
      <circle cx="15.5" cy="12" r="2.5" fill={backgroundColor} stroke={stroke} strokeWidth={strokeWidth} />
      <circle cx="15.5" cy="12" r="1.2" fill={stroke} stroke="none" />
    </svg>
  );
}
