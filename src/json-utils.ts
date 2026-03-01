export function parseJsonSafe<T>(value: string): T | null {
  try {
    if (value.length === 0) {
      return null;
    }
    const normalized = value.startsWith("\ufeff") ? value.slice(1) : value;
    return JSON.parse(normalized) as T;
  } catch {
    return null;
  }
}
