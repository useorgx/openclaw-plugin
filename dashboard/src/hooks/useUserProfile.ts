import { useCallback, useState } from 'react';

const KEY_NAME = 'orgx.user.display-name';
const KEY_SEED_SUFFIX = 'orgx.user.avatar-seed-suffix';

function read(key: string): string {
  if (typeof window === 'undefined') return '';
  return window.localStorage.getItem(key) ?? '';
}

function write(key: string, value: string) {
  if (typeof window === 'undefined') return;
  if (value) window.localStorage.setItem(key, value);
  else window.localStorage.removeItem(key);
}

export function useUserProfile() {
  const [displayName, setDisplayName] = useState(() => read(KEY_NAME));
  const [seedSuffix, setSeedSuffix] = useState(() => read(KEY_SEED_SUFFIX));

  const avatarSeed = (displayName || 'orgx-user') + seedSuffix;

  const updateName = useCallback((name: string) => {
    const trimmed = name.trim();
    write(KEY_NAME, trimmed);
    setDisplayName(trimmed);
  }, []);

  const regenerateAvatar = useCallback(() => {
    const suffix = String(Date.now());
    write(KEY_SEED_SUFFIX, suffix);
    setSeedSuffix(suffix);
  }, []);

  return { displayName, avatarSeed, updateName, regenerateAvatar } as const;
}
