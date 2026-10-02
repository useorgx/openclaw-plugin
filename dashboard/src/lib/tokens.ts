import { tokens as kit } from '@useorgx/orgx-ui-kit/tokens';

// ── Palette ──────────────────────────────────────────────────────
// The OrgX design kit (@useorgx/orgx-ui-kit, vendored under
// dashboard/vendor/orgx-ui-kit by scripts/sync-ui-kit.mjs) is the source of
// truth. The dashboard is dark-only, so these are the kit's dark values; CSS
// and Tailwind read the same values live through the --ox-* variables (see
// src/index.css and tailwind.config.js). Only values the kit has no token for
// (cyan, the elevated surface, the muted text tint) are defined here.
const ox = kit.color.dark;

/** "#rrggbb" -> "r, g, b" for rgba() composition. */
function rgbOf(hex: string): string {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
}
const rgba = (hex: string, alpha: number) => `rgba(${rgbOf(hex)}, ${alpha})`;

export const colors = {
  lime: ox.lime,
  teal: ox.teal,
  cyan: '#0AD4C4',
  iris: ox.iris,

  /** Needs you. */
  amber: ox.warning,
  /** Failed, retryable. */
  red: ox.danger,

  background: ox.bg,
  cardBg: ox['panel-solid'],
  cardBgElevated: '#0C0E14',
  cardBorder: ox.border,
  cardBorderStrong: ox['border-strong'],

  text: ox.text,
  textMuted: '#8F9AB7',
} as const;

// ── Foundational scales ──────────────────────────────────────────
// Explicit foundation exports keep Figma/MCP automation aligned with
// the production dashboard instead of deriving values ad-hoc from classes.

export const spacing = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  2.5: 10,
  3: 12,
  3.5: 14,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  14: 56,
  16: 64,
} as const;

export const radius = {
  none: 0,
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  '2xl': 16,
  shell: 14,
  controlPill: 10,
  mobileTab: 18,
  mobileNav: 24,
  full: 999,
} as const;

export const typography = {
  fontFamily: {
    sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
    mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  },
  weight: {
    regular: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  size: {
    micro: { fontSize: 10, lineHeight: 14, letterSpacing: 0.05 },
    caption: { fontSize: 11, lineHeight: 16, letterSpacing: 0.03 },
    body: { fontSize: 13, lineHeight: 20, letterSpacing: 0 },
    heading: { fontSize: 15, lineHeight: 22, letterSpacing: -0.01 },
    title: { fontSize: 20, lineHeight: 28, letterSpacing: -0.015 },
    display: { fontSize: 28, lineHeight: 34, letterSpacing: -0.02 },
  },
} as const;

export const border = {
  width: {
    hairline: 1,
    focus: 2,
  },
  color: {
    subtle: 'rgba(255, 255, 255, 0.05)',
    default: colors.cardBorder,
    strong: colors.cardBorderStrong,
    accentLime: rgba(colors.lime, 0.28),
    accentTeal: rgba(colors.teal, 0.32),
    destructive: rgba(colors.red, 0.28),
  },
} as const;

export const elevation = {
  surfaceTier1:
    'inset 0 1px 0 rgba(255, 255, 255, 0.035), 0 14px 34px rgba(0, 0, 0, 0.36)',
  surfaceTier2:
    'inset 0 1px 0 rgba(255, 255, 255, 0.045), 0 16px 36px rgba(0, 0, 0, 0.38)',
  hero: `inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 18px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px ${rgba(colors.lime, 0.08)}`,
  card: '0 12px 34px rgba(0, 0, 0, 0.35)',
  mobileNav: '0 20px 50px rgba(0, 0, 0, 0.52)',
  modal: '0 24px 60px rgba(0, 0, 0, 0.5)',
} as const;

export const blur = {
  glass: 14,
  glassStrong: 24,
  mobileNav: 20,
} as const;

export const breakpoints = {
  mobileSm: 375,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  '2xl': 1536,
} as const;

export const zIndex = {
  base: 0,
  raised: 10,
  sticky: 20,
  dropdown: 30,
  mobileNav: 40,
  toast: 50,
  modal: 120,
  missionControlFloating: 220,
  missionControlOverlay: 230,
  appTopLayer: 320,
} as const;

export const interaction = {
  minTouchTarget: 44,
  focusRing: {
    width: border.width.focus,
    color: rgba(colors.lime, 0.35),
  },
  hoverLiftPx: 2,
  activePressPx: 0.5,
} as const;

export const stateTones = {
  active: {
    border: rgba(colors.lime, 0.28),
    background: rgba(colors.lime, 0.11),
    text: rgba(colors.lime, 0.9),
  },
  done: {
    border: rgba(colors.teal, 0.26),
    background: rgba(colors.teal, 0.11),
    text: rgba(colors.teal, 0.9),
  },
  blocked: {
    border: rgba(colors.red, 0.28),
    background: rgba(colors.red, 0.12),
    text: rgba(colors.red, 0.9),
  },
  planned: {
    border: 'rgba(255, 255, 255, 0.16)',
    background: 'rgba(255, 255, 255, 0.06)',
    text: 'rgba(236, 241, 255, 0.74)',
  },
} as const;

/**
 * Unified status color system — single source of truth for all panels.
 * Each status has text, bg, and border at canonical opacities.
 */
export const statusColors = {
  // Kit semantics: teal = accepted / done, amber = needs you, red = failed and retryable.
  success: { text: colors.teal, bg: rgba(colors.teal, 0.12), border: rgba(colors.teal, 0.3) },
  failed: { text: colors.red, bg: rgba(colors.red, 0.12), border: rgba(colors.red, 0.3) },
  warning: { text: colors.amber, bg: rgba(colors.amber, 0.12), border: rgba(colors.amber, 0.3) },
  inProgress: { text: colors.teal, bg: rgba(colors.teal, 0.08), border: rgba(colors.teal, 0.22) },
  idle: { text: 'rgba(255, 255, 255, 0.60)', bg: 'rgba(255, 255, 255, 0.04)', border: 'rgba(255, 255, 255, 0.14)' },
} as const;

/**
 * Canonical opacity scale — prevents ad-hoc opacity math.
 * Use these with any brand/status color instead of `${color}14` hex suffixes.
 */
export const opacity = {
  subtleBg: 0.04,
  lightBg: 0.08,
  mediumBg: 0.12,
  chipBorder: 0.30,
  chipText: 0.90,
  hoverBg: 0.06,
  activeBorder: 0.28,
} as const;

// The seven OrgX agents take their hue and domain from the kit, so the
// dashboard rings match <ox-avatar> and the MCP widgets.
const kitAgent = kit.agent;

export const agentColors: Record<string, string> = {
  Pace: kitAgent.pace.hue,
  Eli: kitAgent.eli.hue,
  Dana: kitAgent.dana.hue,
  Mark: kitAgent.mark.hue,
  Sage: kitAgent.sage.hue,
  Orion: kitAgent.orion.hue,
  Xandy: kitAgent.xandy.hue,
  System: colors.teal,
  Nova: '#A78BFA',
};

export const agentRoles: Record<string, string> = {
  Pace: kitAgent.pace.domain,
  Eli: kitAgent.eli.domain,
  Dana: kitAgent.dana.domain,
  Mark: kitAgent.mark.domain,
  Sage: kitAgent.sage.domain,
  Orion: kitAgent.orion.domain,
  Xandy: kitAgent.xandy.domain,
  System: 'System',
  Nova: 'Research',
};

// Map real backend agent/domain identifiers to domain keys
const DOMAIN_ALIAS_MAP: Record<string, { domain: string; color: string }> = {
  engineering: { domain: kitAgent.eli.domain, color: kitAgent.eli.hue },
  product: { domain: kitAgent.pace.domain, color: kitAgent.pace.hue },
  design: { domain: kitAgent.dana.domain, color: kitAgent.dana.hue },
  marketing: { domain: kitAgent.mark.domain, color: kitAgent.mark.hue },
  sales: { domain: kitAgent.sage.domain, color: kitAgent.sage.hue },
  operations: { domain: kitAgent.orion.domain, color: kitAgent.orion.hue },
  orchestration: { domain: kitAgent.xandy.domain, color: kitAgent.xandy.hue },
  orchestrator: { domain: kitAgent.xandy.domain, color: kitAgent.xandy.hue },
};

function resolveDomainFromName(name: string): { domain: string; color: string } | null {
  // Direct persona match (Eli, Dana, etc.)
  if (agentRoles[name]) return { domain: agentRoles[name], color: agentColors[name] ?? 'rgba(255,255,255,0.4)' };

  // Normalize: "engineering-agent" → "engineering", "orgx-engineering" → "engineering"
  const lower = name.toLowerCase().replace(/[_\s-]+/g, '-');
  for (const [key, value] of Object.entries(DOMAIN_ALIAS_MAP)) {
    if (lower === key || lower === `${key}-agent` || lower === `orgx-${key}` || lower === `orgx-${key}-agent`) {
      return value;
    }
  }

  // Partial match: if the name contains a domain keyword
  for (const [key, value] of Object.entries(DOMAIN_ALIAS_MAP)) {
    if (lower.includes(key)) return value;
  }

  return null;
}

export function getAgentColor(name: string): string {
  return agentColors[name] ?? resolveDomainFromName(name)?.color ?? 'rgba(255, 255, 255, 0.4)';
}

export function getAgentRole(name: string): string | null {
  return agentRoles[name] ?? resolveDomainFromName(name)?.domain ?? null;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

export function normalizeStatus(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

// ── Motion tokens ────────────────────────────────────────────────
// Single source of truth for animation timing across all components.

export const motion = {
  durationInstant: 100,
  durationFast: 150,
  durationStandard: 220,
  durationEntrance: 360,
  durationSlow: 600,
  easingStandard: [0.22, 1, 0.36, 1] as const,
  easingEntrance: [0.16, 1, 0.3, 1] as const,
  easingSpring: { type: 'spring' as const, stiffness: 400, damping: 35 },
  easingBounce: { type: 'spring' as const, stiffness: 320, damping: 28, mass: 0.7 },
} as const;

/** Mission Control transition presets tuned for fast, subtle state switching. */
export const missionControlMotion = {
  surfaceSwitch: {
    duration: motion.durationStandard / 1000,
    ease: motion.easingStandard as unknown as number[],
  },
  contentCrossFade: {
    initial: { opacity: 0, y: 3 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -3 },
    transition: {
      duration: motion.durationFast / 1000,
      ease: motion.easingStandard as unknown as number[],
    },
  },
  railMorphSpring: { type: 'spring' as const, stiffness: 340, damping: 38, mass: 0.72 },
  listStaggerStep: 0.016,
  listStaggerMaxItems: 6,
  segmentedTap: { whileTap: { scale: 0.985 }, transition: { duration: 0.09 } },
} as const;

/** Standard whileTap for all action buttons. */
export const buttonTap = { whileTap: { scale: 0.97 }, transition: { duration: 0.1 } };

/** Subtle hover lift for primary action buttons. */
export const buttonHover = { whileHover: { scale: 1.01 } };

/** Stagger entrance for list items. */
export const listItemVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: Math.min(i, 8) * 0.04,
      duration: motion.durationStandard / 1000,
      ease: motion.easingStandard as unknown as number[],
    },
  }),
};

/** Cross-fade transition for tab/filter content switching. */
export const tabCrossFade = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: motion.easingStandard as unknown as number[] },
};

/** Popover/overflow menu animation. */
export const popoverAnimation = {
  initial: { opacity: 0, scale: 0.95, y: 4 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.95, y: 4 },
  transition: { duration: 0.15, ease: motion.easingStandard as unknown as number[] },
};
