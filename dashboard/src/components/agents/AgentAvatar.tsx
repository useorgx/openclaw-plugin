import { useMemo, useState } from 'react';
import { getAgentColor, getInitials } from '@/lib/tokens';

interface AgentAvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md';
  hint?: string | null;
  src?: string | null;
}

const sizeMap = {
  xs: 'w-6 h-6 text-[9px]',
  sm: 'w-8 h-8 text-[10px]',
  md: 'w-10 h-10 text-[12px]',
};

const baseUrl = '/orgx/live/';
const withBaseUrl = (path: string) => `${baseUrl.replace(/\/+$/, '/')}${path}`;

const avatarMap: Record<string, string> = {
  pace: withBaseUrl('brand/product-orchestrator.png'),
  eli: withBaseUrl('brand/engineering-autopilot.png'),
  mark: withBaseUrl('brand/launch-captain.png'),
  sage: withBaseUrl('brand/pipeline-intelligence.png'),
  orion: withBaseUrl('brand/control-tower.png'),
  dana: withBaseUrl('brand/design-codex.png'),
  xandy: withBaseUrl('brand/product-orchestrator.png'),
  nova: withBaseUrl('brand/product-orchestrator.png'),
  openclaw: withBaseUrl('brand/openclaw-mark.svg'),
  openai: withBaseUrl('brand/openai-mark.svg'),
  anthropic: withBaseUrl('brand/anthropic-mark.svg'),
  orgx: withBaseUrl('brand/orgx-logo.png'),
};

const resolverRules: Array<{ test: RegExp; key: keyof typeof avatarMap }> = [
  { test: /\bpace\b|product|nova|strategist/i, key: 'pace' },
  { test: /\beli\b|engineering|dev-delivery|executor/i, key: 'eli' },
  { test: /\bmark\b|marketing|launch-captain/i, key: 'mark' },
  { test: /\bsage\b|sales|pipeline-intelligence|sales-sage/i, key: 'sage' },
  { test: /\borion\b|operations|ops-orbit|control-tower/i, key: 'orion' },
  { test: /\bdana\b|design|codex/i, key: 'dana' },
  { test: /\bxandy\b|orchestrator|router-all-agents/i, key: 'xandy' },
  { test: /\bholt\b|openclaw/i, key: 'openclaw' },
  { test: /openai|gpt|o[1345]-|codex/i, key: 'openai' },
  { test: /anthropic|claude/i, key: 'anthropic' },
  { test: /\borgx\b/i, key: 'orgx' },
];

function resolveAgentAvatar(...hints: Array<string | null | undefined>): string | null {
  const haystack = hints
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!haystack) return null;

  for (const rule of resolverRules) {
    if (rule.test.test(haystack)) {
      return avatarMap[rule.key];
    }
  }

  return null;
}

export function AgentAvatar({
  name,
  size = 'xs',
  hint,
  src,
}: AgentAvatarProps) {
  const color = getAgentColor(name);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const avatarSrc = useMemo(() => {
    if (src && src.trim()) return src;
    return resolveAgentAvatar(name, hint);
  }, [hint, name, src]);

  const showImage = Boolean(avatarSrc && !failedToLoad);

  return (
    <div
      className={`${sizeMap[size]} overflow-hidden rounded-full flex items-center justify-center font-semibold flex-shrink-0`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
        border: `1px solid ${color}30`,
      }}
    >
      {showImage ? (
        <img
          src={avatarSrc ?? undefined}
          alt={name}
          className="h-full w-full rounded-full object-cover"
          onError={() => setFailedToLoad(true)}
          loading="lazy"
        />
      ) : (
        getInitials(name)
      )}
    </div>
  );
}
