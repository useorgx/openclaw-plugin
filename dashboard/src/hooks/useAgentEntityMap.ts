import { useMemo } from 'react';
import type { ActivityItem, Agent, Initiative, LiveActivityItem } from '@/types';

export interface InferredAgent {
  id: string;
  name: string;
  confidence: 'high' | 'medium' | 'low';
}

export type AgentEntityMap = Map<string, InferredAgent[]>;
type InferenceActivity = ActivityItem | LiveActivityItem;

interface UseAgentEntityMapOptions {
  activities: InferenceActivity[];
  agents: Agent[];
  initiatives: Initiative[];
}

export function useAgentEntityMap({
  activities,
  agents,
  initiatives,
}: UseAgentEntityMapOptions): AgentEntityMap {
  return useMemo(() => {
    const map: Map<string, InferredAgent[]> = new Map();

    const addInference = (
      entityId: string,
      agentId: string,
      agentName: string,
      confidence: InferredAgent['confidence']
    ) => {
      const existing = map.get(entityId) ?? [];
      if (existing.some((a) => a.id === agentId)) return;
      existing.push({ id: agentId, name: agentName, confidence });
      map.set(entityId, existing);
    };

    // High confidence: activities with initiativeId + agentId
    activities.forEach((activity) => {
      const metadataRaw =
        'metadata' in activity &&
        activity.metadata &&
        typeof activity.metadata === 'object'
          ? (activity.metadata as Record<string, unknown>)
          : null;

      const metadata =
        metadataRaw && typeof metadataRaw === 'object' ? metadataRaw : {};

      const initiativeId =
        ('initiativeId' in activity && typeof activity.initiativeId === 'string'
          ? activity.initiativeId
          : undefined) ??
        (metadata.initiativeId as string | undefined) ?? undefined;
      const agentId = activity.agentId ?? undefined;
      const agentName =
        ('agentName' in activity && typeof activity.agentName === 'string'
          ? activity.agentName
          : 'agent' in activity && typeof activity.agent === 'string'
            ? activity.agent
            : undefined) ??
        agentId ??
        'Unknown';

      if (initiativeId && agentId) {
        addInference(initiativeId, agentId, agentName, 'high');
      }
    });

    // Medium confidence: Initiative.avatars matched to agent names
    initiatives.forEach((initiative) => {
      if (!initiative.avatars?.length) return;
      initiative.avatars.forEach((avatarName) => {
        const matchedAgent = agents.find(
          (a) => a.name.toLowerCase() === avatarName.toLowerCase()
        );
        if (matchedAgent) {
          addInference(initiative.id, matchedAgent.id, matchedAgent.name, 'medium');
        } else {
          addInference(initiative.id, `avatar:${avatarName}`, avatarName, 'medium');
        }
      });
    });

    // Low confidence: agent.task text fuzzy match against initiative names
    agents.forEach((agent) => {
      if (!agent.task) return;
      const taskLower = agent.task.toLowerCase();
      initiatives.forEach((initiative) => {
        const nameLower = initiative.name.toLowerCase();
        const nameWords = nameLower.split(/\s+/).filter((w) => w.length > 3);
        const hasMatch = nameWords.some((word) => taskLower.includes(word));
        if (hasMatch) {
          addInference(initiative.id, agent.id, agent.name, 'low');
        }
      });
    });

    return map;
  }, [activities, agents, initiatives]);
}
