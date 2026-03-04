/**
 * Computes downstream impact of a decision for display in the Decision Modal.
 *
 * Uses the MissionControlGraph (already fetched for the initiative view)
 * to determine which workstreams are blocked by the current decision
 * and what the consequences of approving/rejecting are.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DecisionImpact {
  /** Workstreams that depend on the decision's workstream */
  blockedWorkstreams: BlockedWorkstream[];
  /** Total tasks waiting across all blocked workstreams */
  totalBlockedTasks: number;
  /** Whether this workstream is on the critical path */
  criticalPath: boolean;
}

export interface BlockedWorkstream {
  id: string;
  title: string;
  taskCount: number;
  status: string;
}

/** Minimal graph shape — matches buildMissionControlGraph() output */
export interface MissionControlGraphRef {
  nodes: Array<{
    id: string;
    title: string;
    status: string;
    entityType: string;
    children?: Array<{ id: string }>;
  }>;
  edges: Array<{
    source: string;
    target: string;
    edgeType: string;
  }>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute downstream impact of a decision based on the initiative graph.
 * Returns null if insufficient data is available (no graph, no workstream link).
 */
export function computeDecisionImpact(
  decision: { workstreamId?: string | null; initiativeId?: string | null },
  graph: MissionControlGraphRef | null
): DecisionImpact | null {
  if (!graph || !decision.workstreamId) return null;

  const workstreamNode = graph.nodes.find(
    (n) => n.id === decision.workstreamId && n.entityType === 'workstream'
  );
  if (!workstreamNode) return null;

  // Find all workstreams that have a dependency edge from this workstream
  const downstreamIds = new Set(
    graph.edges
      .filter((e) => e.source === decision.workstreamId)
      .map((e) => e.target)
  );

  const blockedWorkstreams: BlockedWorkstream[] = [];
  for (const id of downstreamIds) {
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) continue;
    blockedWorkstreams.push({
      id: node.id,
      title: node.title,
      taskCount: node.children?.length ?? 0,
      status: node.status,
    });
  }

  if (blockedWorkstreams.length === 0) return null;

  const totalBlockedTasks = blockedWorkstreams.reduce(
    (sum, ws) => sum + ws.taskCount,
    0
  );

  // Simple critical path heuristic: if any downstream workstream
  // has its own downstream dependents, this is likely critical path
  const criticalPath = blockedWorkstreams.some((ws) =>
    graph.edges.some((e) => e.source === ws.id)
  );

  return { blockedWorkstreams, totalBlockedTasks, criticalPath };
}

/**
 * Format a DecisionImpact into a human-readable string for display.
 */
export function formatDecisionImpact(impact: DecisionImpact): string {
  const count = impact.blockedWorkstreams.length;
  const names = impact.blockedWorkstreams.map((ws) => ws.title);

  if (count === 1) {
    return `Resolving this unblocks 1 downstream workstream: ${names[0]}.`;
  }
  if (count <= 3) {
    return `Resolving this unblocks ${count} downstream workstreams: ${names.join(', ')}.`;
  }
  return `Resolving this unblocks ${count} downstream workstreams including ${names[0]} and ${names[1]}.`;
}
