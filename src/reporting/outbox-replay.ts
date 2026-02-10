export function extractProgressOutboxMessage(
  payload: Record<string, unknown>
): string | null {
  const messageRaw = payload.message;
  if (typeof messageRaw === "string") {
    const trimmed = messageRaw.trim();
    if (trimmed.length > 0) return trimmed;
  }

  // Backward compatibility: some older outbox payloads used `summary`.
  const summaryRaw = payload.summary;
  if (typeof summaryRaw === "string") {
    const trimmed = summaryRaw.trim();
    if (trimmed.length > 0) return trimmed;
  }

  return null;
}

