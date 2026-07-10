type TaskEntity = {
  id?: unknown;
  status?: unknown;
};

type TaskStatusClient = {
  listEntities: (
    type: string,
    filters?: Record<string, unknown>,
  ) => Promise<{ data?: TaskEntity[] }>;
  updateEntity: (
    type: string,
    id: string,
    updates: Record<string, unknown>,
  ) => Promise<unknown>;
};

export type TaskBlockResult = {
  updated: boolean;
  reason: "blocked" | "already_blocked" | "terminal" | "not_found" | "inactive";
  status: string | null;
};

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export async function blockTaskIfActive(
  client: TaskStatusClient,
  input: { taskId: string; initiativeId?: string | null },
): Promise<TaskBlockResult> {
  const response = await client.listEntities("task", {
    id: input.taskId,
    ...(input.initiativeId ? { initiative_id: input.initiativeId } : {}),
    limit: 2,
  });
  const task = (response.data ?? []).find(
    (row) => typeof row?.id === "string" && row.id === input.taskId,
  );
  if (!task) return { updated: false, reason: "not_found", status: null };

  const status = normalizeStatus(task.status);
  if (status === "done" || status === "completed") {
    return { updated: false, reason: "terminal", status };
  }
  if (status === "blocked") {
    return { updated: false, reason: "already_blocked", status };
  }
  if (status !== "todo" && status !== "in_progress") {
    return { updated: false, reason: "inactive", status: status || null };
  }

  await client.updateEntity("task", input.taskId, { status: "blocked" });
  return { updated: true, reason: "blocked", status };
}
