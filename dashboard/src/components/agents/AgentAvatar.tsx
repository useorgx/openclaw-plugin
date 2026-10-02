import { useMemo, useState } from 'react';
import { OxAvatar, type ActionState, type AgentKey } from '@useorgx/orgx-ui-kit/react';
import { getAgentColor, getInitials } from '@/lib/tokens';
import { formForState, resolveAgentKey, toKitState } from '@/lib/agentIdentity';
import { UserFractalAvatar } from '@/components/settings/UserFractalAvatar';

interface AgentAvatarProps {
  name: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  hint?: string | null;
  src?: string | null;
  /**
   * The agent's run state (any dashboard status spelling, or a kit action
   * state). Picks the avatar form: working = running, asking = needs a person,
   * verifying = checking proof. Omit for the resting face.
   */
  state?: ActionState | string | null;
}

const sizeMap = {
  xs: 'w-6 h-6 text-micro',
  sm: 'w-8 h-8 text-micro',
  md: 'w-10 h-10 text-body',
  lg: 'w-16 h-16 text-title',
};
const sizePxMap = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 64,
} as const;

const USER_NAME_KEY = 'orgx.user.display-name';
const USER_SEED_SUFFIX_KEY = 'orgx.user.avatar-seed-suffix';

const baseUrl = '/orgx/live/';
const withBaseUrl = (path: string) => `${baseUrl.replace(/\/+$/, '/')}${path}`;

// The seven OrgX agents render through <ox-avatar> (kit renders in
// public/avatars). Everything else keeps its brand mark or initials.
const KIT_AGENT_KEYS = new Set<string>(['pace', 'eli', 'mark', 'sage', 'orion', 'dana', 'xandy']);

const avatarMap: Record<string, string> = {
  openclaw: withBaseUrl('brand/openclaw-mark.svg'),
  codex: withBaseUrl('brand/openai-mark.svg'),
  openai: withBaseUrl('brand/openai-mark.svg'),
  anthropic: withBaseUrl('brand/anthropic-mark.svg'),
  orgx: withBaseUrl('brand/orgx-logo.png'),
};

// Broader legacy aliases (substring matches) for names the kit's whole-word
// resolver does not know, e.g. "nova" or "dev-delivery".
const resolverRules: Array<{ test: RegExp; key: string }> = [
  { test: /\bpace\b|product|nova|strategist/i, key: 'pace' },
  { test: /\beli\b|engineering|dev-delivery|executor/i, key: 'eli' },
  { test: /\bmark\b|marketing|launch-captain/i, key: 'mark' },
  { test: /\bsage\b|sales|pipeline-intelligence|sales-sage/i, key: 'sage' },
  { test: /\borion\b|operations|ops-orbit|control-tower/i, key: 'orion' },
  { test: /\bdana\b|design/i, key: 'dana' },
  { test: /\bxandy\b|orchestrator|router-all-agents/i, key: 'xandy' },
  { test: /\bholt\b|openclaw/i, key: 'openclaw' },
  { test: /openai|gpt|o[1345]-|codex/i, key: 'codex' },
  { test: /anthropic|claude/i, key: 'anthropic' },
  { test: /\borgx\b/i, key: 'orgx' },
];

function resolveAvatarKey(...hints: Array<string | null | undefined>): string | null {
  const kitKey = resolveAgentKey(...hints);
  if (kitKey) return kitKey;

  const haystack = hints
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!haystack) return null;

  for (const rule of resolverRules) {
    if (rule.test.test(haystack)) return rule.key;
  }

  return null;
}

function normalizeIdentity(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isUserIdentity(value: string | null | undefined): boolean {
  const normalized = normalizeIdentity(value);
  if (!normalized) return false;
  if (normalized === 'you' || normalized === 'main' || normalized === 'me') return true;
  if (normalized === 'user' || normalized === 'usr') return true;
  if (normalized.startsWith('user_') || normalized.startsWith('usr_')) return true;
  return false;
}

function readUserAvatarSeed(): string {
  if (typeof window === 'undefined') return 'orgx-user';
  try {
    const displayName = (window.localStorage.getItem(USER_NAME_KEY) ?? '').trim();
    const seedSuffix = window.localStorage.getItem(USER_SEED_SUFFIX_KEY) ?? '';
    return `${displayName || 'orgx-user'}${seedSuffix}`;
  } catch {
    return 'orgx-user';
  }
}

export function AgentAvatar({
  name,
  size = 'xs',
  hint,
  src,
  state,
}: AgentAvatarProps) {
  const color = getAgentColor(name);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const showUserAvatar = useMemo(
    () => isUserIdentity(name) || isUserIdentity(hint),
    [hint, name]
  );
  const userAvatarSeed = useMemo(
    () => (showUserAvatar ? readUserAvatarSeed() : null),
    [showUserAvatar]
  );
  const avatarKey = useMemo(() => resolveAvatarKey(name, hint), [hint, name]);
  const kitAgent: AgentKey | null =
    !showUserAvatar && !(src && src.trim()) && avatarKey && KIT_AGENT_KEYS.has(avatarKey)
      ? (avatarKey as AgentKey)
      : null;
  const avatarSrc = useMemo(() => {
    if (src && src.trim()) return src;
    return avatarKey ? avatarMap[avatarKey] ?? null : null;
  }, [avatarKey, src]);

  if (kitAgent) {
    const form = formForState(state ? toKitState(state).state : null);
    return (
      <span
        data-agent-avatar="true"
        className={`${sizeMap[size]} inline-flex flex-shrink-0`}
      >
        <OxAvatar
          className="ox-avatar-fill"
          agent={kitAgent}
          form={form}
          size={sizePxMap[size]}
        />
      </span>
    );
  }

  const showImage = Boolean(!showUserAvatar && avatarSrc && !failedToLoad);

  return (
    <div
      data-agent-avatar="true"
      className={`${sizeMap[size]} overflow-hidden rounded-full flex items-center justify-center font-semibold flex-shrink-0`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
        border: `1px solid ${color}30`,
      }}
    >
      {showUserAvatar && userAvatarSeed ? (
        <UserFractalAvatar
          seed={userAvatarSeed}
          size={sizePxMap[size]}
          animate={false}
          className="h-full w-full"
        />
      ) : showImage ? (
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

AgentAvatar.displayName = 'AgentAvatar';
