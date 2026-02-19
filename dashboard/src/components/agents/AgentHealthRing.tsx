import { useMemo } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { colors } from '@/lib/tokens';

interface AgentHealthRingProps {
  /** Total running sessions */
  running: number;
  /** Total blocked/failed sessions */
  blocked: number;
  /** Total paused sessions */
  paused: number;
  /** Ring size in px (outer diameter) */
  size?: number;
  children: React.ReactNode;
}

export function AgentHealthRing({
  running,
  blocked,
  paused,
  size = 36,
  children,
}: AgentHealthRingProps) {
  const prefersReducedMotion = useReducedMotion();
  const total = running + blocked + paused;

  const segments = useMemo(() => {
    if (total === 0) return [];

    const result: Array<{ color: string; fraction: number }> = [];
    if (running > 0) result.push({ color: colors.lime, fraction: running / total });
    if (blocked > 0) result.push({ color: colors.red, fraction: blocked / total });
    if (paused > 0) result.push({ color: colors.amber, fraction: paused / total });
    return result;
  }, [running, blocked, paused, total]);

  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  if (total === 0) {
    return (
      <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          className="absolute inset-0"
          style={{ transform: 'rotate(-90deg)' }}
        >
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={strokeWidth}
          />
        </svg>
        <div className="relative z-10">{children}</div>
      </div>
    );
  }

  let offset = 0;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        className="absolute inset-0"
        style={{ transform: 'rotate(-90deg)' }}
      >
        {/* Background ring */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth={strokeWidth}
        />
        {/* Colored segments */}
        {segments.map((seg, i) => {
          const dashLength = seg.fraction * circumference;
          const dashOffset = -offset;
          offset += dashLength;

          return (
            <motion.circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={`${dashLength} ${circumference - dashLength}`}
              strokeDashoffset={dashOffset}
              initial={prefersReducedMotion ? false : { strokeDasharray: `0 ${circumference}` }}
              animate={{ strokeDasharray: `${dashLength} ${circumference - dashLength}` }}
              transition={{ duration: 0.5, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
              style={{ opacity: 0.85 }}
            />
          );
        })}
      </svg>
      <div className="relative z-10">{children}</div>
    </div>
  );
}
