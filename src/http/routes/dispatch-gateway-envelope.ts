import { randomUUID } from "node:crypto";

export type DispatchGatewayEnvelopeInput = {
  dispatchId?: string;
  dispatchMode: string;
  route: "mission-control.next-up.play" | "mission-control.auto-continue.start";
  source: "manual_play" | "auto_continue_start";
  initiativeId: string;
  workstreamId?: string | null;
  workstreamIds?: string[] | null;
  taskIds?: string[] | null;
};

function uniqueStringIds(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0)
    )
  );
}

export function buildDispatchGatewayEnvelope(input: DispatchGatewayEnvelopeInput) {
  return {
    dispatchId: input.dispatchId ?? randomUUID(),
    dispatchMode: input.dispatchMode,
    executionPath: "orgx_orchestrator_gateway",
    dispatchGateway: "orchestrator-agent",
    dispatchLineage: {
      route: input.route,
      source: input.source,
      dispatchedAt: new Date().toISOString(),
      initiativeId: input.initiativeId,
      workstreamId: input.workstreamId ?? null,
      workstreamIds: uniqueStringIds([
        input.workstreamId,
        ...(input.workstreamIds ?? []),
      ]),
      taskIds: uniqueStringIds(input.taskIds ?? []),
    },
  } as const;
}
