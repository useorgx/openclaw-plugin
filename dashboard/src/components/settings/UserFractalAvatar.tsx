import { motion } from 'framer-motion';
import { useMemo } from 'react';
import { colors, motion as motionTokens } from '@/lib/tokens';
import { cn } from '@/lib/utils';

/* ── Deterministic hashing & PRNG ──────────────────────────────── */

function seedHash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── Palette ───────────────────────────────────────────────────── */

const PALETTE = [colors.lime, colors.teal, colors.iris, colors.cyan];

/* ── SVG arc path helper ───────────────────────────────────────── */

function arcPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startAngle: number,
  endAngle: number,
): string {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const cos = Math.cos;
  const sin = Math.sin;

  const s = toRad(startAngle);
  const e = toRad(endAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  const x1 = cx + rOuter * cos(s);
  const y1 = cy + rOuter * sin(s);
  const x2 = cx + rOuter * cos(e);
  const y2 = cy + rOuter * sin(e);
  const x3 = cx + rInner * cos(e);
  const y3 = cy + rInner * sin(e);
  const x4 = cx + rInner * cos(s);
  const y4 = cy + rInner * sin(s);

  return [
    `M ${x1} ${y1}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

/* ── Cell generation ───────────────────────────────────────────── */

interface Cell {
  d: string;
  fill: string;
  opacity: number;
}

function generateCells(seed: string): Cell[] {
  const rng = mulberry32(seedHash(seed));
  const ringCount = 3 + Math.floor(rng() * 2); // 3-4 rings
  const cells: Cell[] = [];
  const cx = 50;
  const cy = 50;

  for (let ring = 0; ring < ringCount; ring++) {
    const rInner = 8 + ring * 10;
    const rOuter = rInner + 9;
    const wedgeCount = 6 + Math.floor(rng() * 6); // 6-11 wedges
    const angleStep = 360 / wedgeCount;
    const gapDeg = 1.5 + rng() * 2;

    for (let w = 0; w < wedgeCount; w++) {
      if (rng() < 0.15) continue; // skip some for variety
      const startAngle = w * angleStep + gapDeg / 2;
      const endAngle = (w + 1) * angleStep - gapDeg / 2;
      const color = PALETTE[Math.floor(rng() * PALETTE.length)];
      const opacity = 0.25 + rng() * 0.55;

      cells.push({
        d: arcPath(cx, cy, rInner, rOuter, startAngle, endAngle),
        fill: color,
        opacity,
      });
    }
  }

  return cells;
}

/* ── Component ─────────────────────────────────────────────────── */

interface UserFractalAvatarProps {
  seed: string;
  size: number;
  className?: string;
  animate?: boolean;
}

export function UserFractalAvatar({
  seed,
  size,
  className,
  animate = true,
}: UserFractalAvatarProps) {
  const cells = useMemo(() => generateCells(seed), [seed]);

  return (
    <motion.svg
      key={seed}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn('flex-shrink-0', className)}
      initial={animate ? { opacity: 0, scale: 0.85, rotate: -30 } : false}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{
        duration: 0.5,
        ease: motionTokens.easingEntrance as unknown as number[],
      }}
    >
      <defs>
        <clipPath id={`avatar-clip-${seed}`}>
          <circle cx="50" cy="50" r="48" />
        </clipPath>
        <radialGradient id={`avatar-glow-${seed}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={colors.lime} stopOpacity="0.08" />
          <stop offset="100%" stopColor={colors.lime} stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Background */}
      <circle cx="50" cy="50" r="48" fill={colors.cardBg} />

      {/* Glow */}
      <circle cx="50" cy="50" r="48" fill={`url(#avatar-glow-${seed})`} />

      {/* Cells */}
      <g clipPath={`url(#avatar-clip-${seed})`}>
        {cells.map((cell, i) => (
          <motion.path
            key={i}
            d={cell.d}
            fill={cell.fill}
            initial={animate ? { opacity: 0, scale: 0.85 } : false}
            animate={{ opacity: cell.opacity, scale: 1 }}
            transition={{
              delay: i * 0.012,
              duration: 0.35,
              ease: motionTokens.easingEntrance as unknown as number[],
            }}
            style={{ transformOrigin: '50px 50px' }}
          />
        ))}
      </g>

      {/* Border ring */}
      <circle
        cx="50"
        cy="50"
        r="48"
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
      />
    </motion.svg>
  );
}
