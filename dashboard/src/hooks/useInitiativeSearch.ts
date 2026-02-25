import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import type { Initiative } from '@/types';
import { isDemoModeEnabled } from '@/lib/initiativeIds';
import {
  isVisibleInitiativeStatus,
  toInitiative,
  type RawEntityInitiative,
} from '@/hooks/initiativeEntityMapper';

type EntityListResponse<T = unknown> = {
  data?: T[];
  pagination?: {
    has_more?: boolean;
  };
};

type RelatedEntitySearchRow = {
  initiative_id?: string | null;
};

const INITIATIVE_PAGE_SIZE = 100;
const INITIATIVE_MAX_PAGES = 5;
const RELATED_PAGE_SIZE = 75;
const RELATED_MAX_PAGES = 3;
const RELATED_ENTITY_TYPES = ['workstream', 'milestone', 'task'] as const;
const ID_CHUNK_SIZE = 60;

function toEpoch(value: string | null | undefined): number {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function chunk<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function fetchEntityPages<T>(
  params: URLSearchParams,
  pageSize: number,
  maxPages: number
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  for (let page = 0; page < maxPages; page += 1) {
    const pageParams = new URLSearchParams(params);
    pageParams.set('limit', String(pageSize));
    pageParams.set('offset', String(offset));

    const response = await fetch(`/orgx/api/entities?${pageParams.toString()}`);
    if (!response.ok) break;

    const json = (await response.json()) as EntityListResponse<T>;
    const pageRows = json.data ?? [];
    rows.push(...pageRows);

    const hasMore = Boolean(json.pagination?.has_more);
    if (!hasMore || pageRows.length === 0) break;
    offset += pageSize;
  }

  return rows;
}

function computeScore(
  initiative: Initiative,
  query: string,
  tokens: string[],
  relatedMatch: boolean
): number {
  const title = initiative.name.toLowerCase();
  const summary = (initiative.description ?? '').toLowerCase();

  let score = 0;
  if (relatedMatch) score += 65;
  if (title === query) score += 140;
  if (title.startsWith(query)) score += 100;
  if (title.includes(query)) score += 80;
  if (summary.includes(query)) score += 40;

  for (const token of tokens) {
    if (title.includes(token)) score += 22;
    if (summary.includes(token)) score += 8;
  }

  return score;
}

export function useInitiativeSearch(
  query: string,
  enabled: boolean,
  projectId: string | null = null
) {
  const normalizedQuery = query.trim().toLowerCase();
  const scopedProjectId = projectId?.trim() ?? '';

  return useQuery<Initiative[]>({
    queryKey: queryKeys.initiativeSearch({
      query: normalizedQuery,
      projectId: scopedProjectId || null,
    }),
    enabled: enabled && normalizedQuery.length >= 2,
    queryFn: async () => {
      if (normalizedQuery.length < 2 || isDemoModeEnabled()) return [];

      const buildScopedParams = (input: Record<string, string>): URLSearchParams => {
        const params = new URLSearchParams(input);
        if (scopedProjectId.length > 0) {
          params.set('workspace_id', scopedProjectId);
        }
        return params;
      };

      const directInitiativeRows = await fetchEntityPages<RawEntityInitiative>(
        buildScopedParams({
          type: 'initiative',
          search: normalizedQuery,
        }),
        INITIATIVE_PAGE_SIZE,
        INITIATIVE_MAX_PAGES
      );

      const relatedSearchResults = await Promise.all(
        RELATED_ENTITY_TYPES.map((type) =>
          fetchEntityPages<RelatedEntitySearchRow>(
            buildScopedParams({
              type,
              search: normalizedQuery,
            }),
            RELATED_PAGE_SIZE,
            RELATED_MAX_PAGES
          )
        )
      );

      const relatedInitiativeIds = new Set<string>();
      for (const rows of relatedSearchResults) {
        for (const row of rows) {
          const initiativeId = row.initiative_id?.trim();
          if (initiativeId) {
            relatedInitiativeIds.add(initiativeId);
          }
        }
      }

      const relatedInitiatives: RawEntityInitiative[] = [];
      for (const idChunk of chunk(Array.from(relatedInitiativeIds), ID_CHUNK_SIZE)) {
        if (idChunk.length === 0) continue;
        const params = buildScopedParams({
          type: 'initiative',
          ids: idChunk.join(','),
          limit: String(idChunk.length),
          offset: '0',
        });
        const response = await fetch(`/orgx/api/entities?${params.toString()}`);
        if (!response.ok) continue;
        const json = (await response.json()) as EntityListResponse<RawEntityInitiative>;
        relatedInitiatives.push(...(json.data ?? []));
      }

      const rows = [...directInitiativeRows, ...relatedInitiatives];
      const deduped = new Map<string, RawEntityInitiative>();
      for (const row of rows) {
        const current = deduped.get(row.id);
        if (!current) {
          deduped.set(row.id, row);
          continue;
        }
        if (toEpoch(row.updated_at ?? row.created_at) > toEpoch(current.updated_at ?? current.created_at)) {
          deduped.set(row.id, row);
        }
      }

      const tokens = tokenizeQuery(normalizedQuery);
      return Array.from(deduped.values())
        .filter((item) => isVisibleInitiativeStatus(item.status))
        .map(toInitiative)
        .filter((initiative) => {
          if (relatedInitiativeIds.has(initiative.id)) return true;
          const haystack = [
            initiative.name,
            initiative.description ?? '',
            initiative.rawStatus ?? '',
            initiative.status,
          ]
            .join(' ')
            .toLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
        .sort((a, b) => {
          const scoreDelta =
            computeScore(b, normalizedQuery, tokens, relatedInitiativeIds.has(b.id)) -
            computeScore(a, normalizedQuery, tokens, relatedInitiativeIds.has(a.id));
          if (scoreDelta !== 0) return scoreDelta;
          return toEpoch(b.updatedAt ?? b.createdAt) - toEpoch(a.updatedAt ?? a.createdAt);
        });
    },
    staleTime: 15_000,
  });
}
