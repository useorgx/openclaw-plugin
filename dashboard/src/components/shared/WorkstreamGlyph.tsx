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
        <rect x="3" y="3" width="18" height="18" rx="4.5" fill={backgroundColor} stroke="none" />
      ) : null}
      <path d="M5.5 7h5.8l6.7 6" />
      <path d="M5.5 17h5.8l6.7-6" />
      <path d="M5.5 12h12.5" />
      <path d="m15.3 9.3 2.7 2.7-2.7 2.7" />
    </svg>
  );
}
