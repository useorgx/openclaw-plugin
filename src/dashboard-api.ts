/**
 * Dashboard API — Formats OrgX data for the React dashboard SPA.
 *
 * Transforms the cached OrgSnapshot into the shapes the dashboard components
 * expect, and exposes an onboarding check (is the API key configured?).
 */

import type { OnboardingState, OrgSnapshot } from "./types.js";

// =============================================================================
// Response shapes consumed by the dashboard
// =============================================================================

export interface DashboardStatus {
  connected: boolean;
  syncedAt: string | null;
  initiativeCount: number;
  activeAgentCount: number;
  activeTaskCount: number;
  pendingDecisionCount: number;
}

export interface DashboardAgent {
  id: string;
  name: string;
  domain: string;
  status: "active" | "idle" | "throttled";
  currentTask: string | null;
  lastActive: string | null;
}

export interface DashboardActivityItem {
  id: string;
  type: "task" | "decision" | "agent";
  title: string;
  status: string;
  domain?: string;
  urgency?: string;
  timestamp: string | null;
}

export interface DashboardInitiative {
  id: string;
  title: string;
  status: string;
  progress: number | null;
  workstreams: string[];
}

// =============================================================================
// Formatting helpers
// =============================================================================

export function formatStatus(snapshot: OrgSnapshot | null): DashboardStatus {
  if (!snapshot) {
    return {
      connected: false,
      syncedAt: null,
      initiativeCount: 0,
      activeAgentCount: 0,
      activeTaskCount: 0,
      pendingDecisionCount: 0,
    };
  }

  return {
    connected: true,
    syncedAt: snapshot.syncedAt ?? null,
    initiativeCount: snapshot.initiatives?.length ?? 0,
    activeAgentCount:
      snapshot.agents?.filter((a) => a.status === "active").length ?? 0,
    activeTaskCount: snapshot.activeTasks?.length ?? 0,
    pendingDecisionCount: snapshot.pendingDecisions?.length ?? 0,
  };
}

export function formatAgents(snapshot: OrgSnapshot | null): DashboardAgent[] {
  if (!snapshot?.agents) return [];

  return snapshot.agents.map((a) => ({
    id: a.id,
    name: a.name,
    domain: a.domain,
    status: a.status,
    currentTask: a.currentTask ?? null,
    lastActive: a.lastActive ?? null,
  }));
}

export function formatActivity(
  snapshot: OrgSnapshot | null
): DashboardActivityItem[] {
  if (!snapshot) return [];

  const items: DashboardActivityItem[] = [];

  // Active tasks → activity items
  if (snapshot.activeTasks) {
    for (const t of snapshot.activeTasks) {
      items.push({
        id: t.id,
        type: "task",
        title: t.title,
        status: t.status,
        domain: t.domain,
        timestamp: snapshot.syncedAt ?? null,
      });
    }
  }

  // Pending decisions → activity items
  if (snapshot.pendingDecisions) {
    for (const d of snapshot.pendingDecisions) {
      items.push({
        id: d.id,
        type: "decision",
        title: d.title,
        status: "pending",
        urgency: d.urgency,
        timestamp: snapshot.syncedAt ?? null,
      });
    }
  }

  // Agent state changes → activity items
  if (snapshot.agents) {
    for (const a of snapshot.agents) {
      if (a.status === "active" && a.currentTask) {
        items.push({
          id: a.id,
          type: "agent",
          title: `${a.name} working on: ${a.currentTask}`,
          status: a.status,
          domain: a.domain,
          timestamp: a.lastActive ?? snapshot.syncedAt ?? null,
        });
      }
    }
  }

  return items;
}

export function formatInitiatives(
  snapshot: OrgSnapshot | null
): DashboardInitiative[] {
  if (!snapshot?.initiatives) return [];

  return snapshot.initiatives.map((i) => ({
    id: i.id,
    title: i.title,
    status: i.status,
    progress: i.progress ?? null,
    workstreams: i.workstreams ?? [],
  }));
}

export function getOnboardingState(state: OnboardingState): OnboardingState {
  return {
    ...state,
  };
}
