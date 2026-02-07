import { colors } from '@/lib/tokens';

export type ProviderId =
  | 'codex'
  | 'openai'
  | 'anthropic'
  | 'openclaw'
  | 'orgx'
  | 'unknown';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  accent: string;
  tint: string;
}

const providerInfo: Record<ProviderId, ProviderInfo> = {
  codex: {
    id: 'codex',
    label: 'Codex',
    accent: '#10B981',
    tint: 'rgba(16, 185, 129, 0.18)',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    accent: '#9F7AEA',
    tint: 'rgba(159, 122, 234, 0.2)',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    accent: '#F5B700',
    tint: 'rgba(245, 183, 0, 0.18)',
  },
  openclaw: {
    id: 'openclaw',
    label: 'OpenClaw',
    accent: '#FF4D4D',
    tint: 'rgba(255, 77, 77, 0.18)',
  },
  orgx: {
    id: 'orgx',
    label: 'OrgX',
    accent: colors.lime,
    tint: 'rgba(191, 255, 0, 0.18)',
  },
  unknown: {
    id: 'unknown',
    label: 'Agent',
    accent: colors.teal,
    tint: 'rgba(20, 184, 166, 0.18)',
  },
};

const KEY_HINTS = [
  'provider',
  'vendor',
  'model',
  'runtime',
  'engine',
  'agent',
  'name',
  'title',
  'label',
  'summary',
  'description',
  'source',
];

function collectStrings(value: unknown, sink: string[], depth: number, seen: Set<object>) {
  if (value === null || value === undefined || depth > 2) return;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > 0) {
      sink.push(normalized);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, sink, depth + 1, seen);
    }
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (typeof entry === 'string') {
        if (
          KEY_HINTS.some((hint) => lowerKey.includes(hint)) ||
          lowerKey.startsWith('meta') ||
          lowerKey.endsWith('id')
        ) {
          collectStrings(entry, sink, depth + 1, seen);
        }
      } else if (typeof entry === 'object' && entry !== null) {
        collectStrings(entry, sink, depth + 1, seen);
      }
    }
  }
}

function detectProvider(text: string): ProviderId | null {
  const normalized = text.toLowerCase();

  if (
    /\bcodex\b/.test(normalized) ||
    /\bcursor\b/.test(normalized) ||
    normalized.includes('openai/codex')
  ) {
    return 'codex';
  }

  if (
    normalized.includes('openclaw') ||
    normalized.includes('clawdbot') ||
    normalized.includes('moltbot')
  ) {
    return 'openclaw';
  }

  if (
    normalized.includes('anthropic') ||
    normalized.includes('claude') ||
    normalized.includes('sonnet') ||
    normalized.includes('opus')
  ) {
    return 'anthropic';
  }

  if (
    normalized.includes('openai') ||
    normalized.includes('chatgpt') ||
    /\bgpt[-\s]?\d/.test(normalized) ||
    /\bo[134]/.test(normalized)
  ) {
    return 'openai';
  }

  if (normalized.includes('orgx')) {
    return 'orgx';
  }

  return null;
}

export function resolveProvider(...sources: unknown[]): ProviderInfo {
  const strings: string[] = [];
  const seen = new Set<object>();
  for (const source of sources) {
    collectStrings(source, strings, 0, seen);
  }

  for (const text of strings) {
    const provider = detectProvider(text);
    if (provider) {
      return providerInfo[provider];
    }
  }

  return providerInfo.unknown;
}

export function getProviderInfo(providerId: ProviderId): ProviderInfo {
  return providerInfo[providerId] ?? providerInfo.unknown;
}
