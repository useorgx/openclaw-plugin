import { Buffer } from "node:buffer";

import type { RuntimeInstanceRecord } from "../../runtime-instance-store.js";

export type RuntimeStreamSubscriber = {
  id: string;
  write: (chunk: Buffer) => boolean;
  end: () => void;
};

type CreateRuntimeSseHubDeps = {
  listRuntimeInstances: (input: { limit: number }) => RuntimeInstanceRecord[];
};

export function createRuntimeSseHub(deps: CreateRuntimeSseHubDeps): {
  runtimeStreamSubscribers: Map<string, RuntimeStreamSubscriber>;
  writeRuntimeSseEvent: (
    subscriber: RuntimeStreamSubscriber,
    event: string,
    payload: unknown
  ) => void;
  stopRuntimeStreamTimers: () => void;
  broadcastRuntimeSse: (event: string, payload: unknown) => void;
  ensureRuntimeStreamTimers: () => void;
} {
  const runtimeStreamSubscribers = new Map<string, RuntimeStreamSubscriber>();
  let runtimeStreamKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let runtimeStreamStalenessTimer: ReturnType<typeof setInterval> | null = null;
  let runtimeStreamFingerprintById: Map<string, string> = new Map();

  function runtimeStreamFingerprint(instance: RuntimeInstanceRecord): string {
    return [
      instance.state,
      instance.lastHeartbeatAt ?? "",
      instance.lastEventAt ?? "",
      instance.progressPct ?? "",
      instance.phase ?? "",
    ].join("|");
  }

  function writeRuntimeSseEvent(
    subscriber: RuntimeStreamSubscriber,
    event: string,
    payload: unknown
  ): void {
    const data = JSON.stringify(payload ?? null);
    subscriber.write(
      Buffer.from(
        `event: ${event}
data: ${data}

`,
        "utf8"
      )
    );
  }

  function stopRuntimeStreamTimers(): void {
    if (runtimeStreamKeepaliveTimer) {
      clearInterval(runtimeStreamKeepaliveTimer);
      runtimeStreamKeepaliveTimer = null;
    }
    if (runtimeStreamStalenessTimer) {
      clearInterval(runtimeStreamStalenessTimer);
      runtimeStreamStalenessTimer = null;
    }
    runtimeStreamFingerprintById = new Map();
  }

  function broadcastRuntimeSse(event: string, payload: unknown): void {
    if (runtimeStreamSubscribers.size === 0) return;

    for (const subscriber of runtimeStreamSubscribers.values()) {
      try {
        writeRuntimeSseEvent(subscriber, event, payload);
      } catch {
        try {
          subscriber.end();
        } catch {
          // ignore
        }
        runtimeStreamSubscribers.delete(subscriber.id);
      }
    }

    if (runtimeStreamSubscribers.size === 0) {
      stopRuntimeStreamTimers();
    }
  }

  function ensureRuntimeStreamTimers(): void {
    if (runtimeStreamKeepaliveTimer || runtimeStreamStalenessTimer) return;

    runtimeStreamKeepaliveTimer = setInterval(() => {
      if (runtimeStreamSubscribers.size === 0) {
        stopRuntimeStreamTimers();
        return;
      }

      const payload = Buffer.from(`: ping ${Date.now()}
`, "utf8");
      for (const subscriber of runtimeStreamSubscribers.values()) {
        try {
          subscriber.write(payload);
        } catch {
          try {
            subscriber.end();
          } catch {
            // ignore
          }
          runtimeStreamSubscribers.delete(subscriber.id);
        }
      }
    }, 20_000);
    runtimeStreamKeepaliveTimer.unref?.();

    runtimeStreamStalenessTimer = setInterval(() => {
      if (runtimeStreamSubscribers.size === 0) {
        stopRuntimeStreamTimers();
        return;
      }

      // listRuntimeInstances applies staleness before returning.
      const instances = deps.listRuntimeInstances({ limit: 600 });
      const nextFingerprintById = new Map<string, string>();

      for (const instance of instances) {
        const fingerprint = runtimeStreamFingerprint(instance);
        nextFingerprintById.set(instance.id, fingerprint);

        const previous = runtimeStreamFingerprintById.get(instance.id);
        if (previous && previous === fingerprint) {
          continue;
        }

        runtimeStreamFingerprintById.set(instance.id, fingerprint);
        broadcastRuntimeSse("runtime.updated", instance);
      }

      runtimeStreamFingerprintById = nextFingerprintById;
    }, 15_000);
    runtimeStreamStalenessTimer.unref?.();
  }

  return {
    runtimeStreamSubscribers,
    writeRuntimeSseEvent,
    stopRuntimeStreamTimers,
    broadcastRuntimeSse,
    ensureRuntimeStreamTimers,
  };
}
