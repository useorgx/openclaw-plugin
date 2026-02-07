import { createContext, useContext, useState, useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { AgentEntityMap } from '@/hooks/useAgentEntityMap';
import { useEntityMutations } from '@/hooks/useEntityMutations';
import type {
  Initiative,
  InitiativeWorkstream,
  InitiativeMilestone,
  InitiativeTask,
} from '@/types';

export type MissionControlDateField = 'target' | 'created' | 'updated';
export type MissionControlDatePreset =
  | 'any'
  | 'missing'
  | 'overdue'
  | 'today'
  | 'next_7_days'
  | 'next_30_days'
  | 'past_7_days'
  | 'past_30_days'
  | 'custom_range';

export type GroupByOption = 'none' | 'status' | 'date' | 'category';

export type EntityModalTarget =
  | { type: 'initiative'; entity: Initiative }
  | { type: 'workstream'; entity: InitiativeWorkstream; initiative: Initiative }
  | { type: 'milestone'; entity: InitiativeMilestone; initiative: Initiative }
  | { type: 'task'; entity: InitiativeTask; initiative: Initiative };

type EntityMutations = ReturnType<typeof useEntityMutations>;

interface MissionControlState {
  agentEntityMap: AgentEntityMap;
  expandedInitiatives: Set<string>;
  modalTarget: EntityModalTarget | null;
  searchQuery: string;
  statusFilters: string[];
  dateField: MissionControlDateField;
  datePreset: MissionControlDatePreset;
  dateStart: string;
  dateEnd: string;
  activeFilterCount: number;
  hasActiveFilters: boolean;
  groupBy: GroupByOption;
  authToken: string | null;
  embedMode: boolean;
  mutations: EntityMutations;
  toggleExpanded: (id: string) => void;
  expandInitiative: (id: string) => void;
  expandAll: (ids: string[]) => void;
  collapseAll: () => void;
  openModal: (target: EntityModalTarget) => void;
  closeModal: () => void;
  setSearchQuery: (query: string) => void;
  setStatusFilters: (filters: string[]) => void;
  toggleStatusFilter: (status: string) => void;
  setDateField: (field: MissionControlDateField) => void;
  setDatePreset: (preset: MissionControlDatePreset) => void;
  setDateStart: (value: string) => void;
  setDateEnd: (value: string) => void;
  setGroupBy: (groupBy: GroupByOption) => void;
  clearFilters: () => void;
}

const MissionControlContext = createContext<MissionControlState | null>(null);

export function useMissionControl() {
  const ctx = useContext(MissionControlContext);
  if (!ctx) throw new Error('useMissionControl must be used within MissionControlProvider');
  return ctx;
}

interface MissionControlProviderProps {
  children: ReactNode;
  agentEntityMap: AgentEntityMap;
  authToken: string | null;
  embedMode: boolean;
}

export function MissionControlProvider({
  children,
  agentEntityMap,
  authToken,
  embedMode,
}: MissionControlProviderProps) {
  const [expandedInitiatives, setExpandedInitiatives] = useState<Set<string>>(new Set());
  const [modalTarget, setModalTarget] = useState<EntityModalTarget | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [dateField, setDateField] = useState<MissionControlDateField>('target');
  const [datePreset, setDatePreset] = useState<MissionControlDatePreset>('any');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  const mutations = useEntityMutations({ authToken, embedMode });

  const toggleExpanded = useCallback((id: string) => {
    setExpandedInitiatives((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandInitiative = useCallback((id: string) => {
    setExpandedInitiatives((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback((ids: string[]) => {
    setExpandedInitiatives(new Set(ids));
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedInitiatives(new Set());
  }, []);

  const openModal = useCallback((target: EntityModalTarget) => {
    setModalTarget(target);
  }, []);

  const closeModal = useCallback(() => {
    setModalTarget(null);
  }, []);

  const toggleStatusFilter = useCallback((status: string) => {
    setStatusFilters((previous) => {
      const normalized = status.trim().toLowerCase();
      if (!normalized) return previous;
      if (previous.includes(normalized)) {
        return previous.filter((item) => item !== normalized);
      }
      return [...previous, normalized];
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSearchQuery('');
    setStatusFilters([]);
    setDateField('target');
    setDatePreset('any');
    setDateStart('');
    setDateEnd('');
  }, []);

  const activeFilterCount =
    statusFilters.length +
    (dateField !== 'target' ? 1 : 0) +
    (datePreset !== 'any' ? 1 : 0);

  const hasActiveFilters =
    searchQuery.trim().length > 0 || activeFilterCount > 0;

  const value = useMemo(
    () => ({
      agentEntityMap,
      expandedInitiatives,
      modalTarget,
      searchQuery,
      statusFilters,
      dateField,
      datePreset,
      dateStart,
      dateEnd,
      activeFilterCount,
      hasActiveFilters,
      groupBy,
      authToken,
      embedMode,
      mutations,
      toggleExpanded,
      expandInitiative,
      expandAll,
      collapseAll,
      openModal,
      closeModal,
      setSearchQuery,
      setStatusFilters,
      toggleStatusFilter,
      setDateField,
      setDatePreset,
      setDateStart,
      setDateEnd,
      setGroupBy,
      clearFilters,
    }),
    [
      agentEntityMap,
      expandedInitiatives,
      modalTarget,
      searchQuery,
      statusFilters,
      dateField,
      datePreset,
      dateStart,
      dateEnd,
      activeFilterCount,
      hasActiveFilters,
      groupBy,
      authToken,
      embedMode,
      mutations,
      toggleExpanded,
      expandInitiative,
      expandAll,
      collapseAll,
      openModal,
      closeModal,
      setStatusFilters,
      toggleStatusFilter,
      setDateField,
      setDatePreset,
      setDateStart,
      setDateEnd,
      setGroupBy,
      clearFilters,
    ]
  );

  return (
    <MissionControlContext.Provider value={value}>
      {children}
    </MissionControlContext.Provider>
  );
}
