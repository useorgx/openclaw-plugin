import type { SharedState } from "./shared-state.js";

export type RouteMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "*";

export interface RouteContext<TState = SharedState, TReq = unknown, TRes = unknown> {
  req: TReq;
  res: TRes;
  path: string;
  query: URLSearchParams;
  body: unknown;
  state: TState;
}

export type RouteHandler<TState = SharedState, TReq = unknown, TRes = unknown> = (
  ctx: RouteContext<TState, TReq, TRes>
) => Promise<void> | void;

export interface RouteDefinition<TState = SharedState, TReq = unknown, TRes = unknown> {
  method: RouteMethod;
  pattern: string; // exact match, or prefix match with trailing /*
  handler: RouteHandler<TState, TReq, TRes>;
  description?: string;
}

export interface Router<TState = SharedState, TReq = unknown, TRes = unknown> {
  add: (
    method: RouteMethod,
    pattern: string,
    handler: RouteHandler<TState, TReq, TRes>,
    description?: string
  ) => void;
  match: (method: string, path: string) => RouteDefinition<TState, TReq, TRes> | undefined;
  routes: () => readonly RouteDefinition<TState, TReq, TRes>[];
}

interface IndexedRouteDefinition<TState = SharedState, TReq = unknown, TRes = unknown>
  extends RouteDefinition<TState, TReq, TRes> {
  order: number;
  prefixBase: string | null;
}

function normalizePrefixBase(pattern: string): string | null {
  return pattern.endsWith("/*") ? pattern.slice(0, -1) : null;
}

function getOrCreateBucket<TKey, TValue>(map: Map<TKey, TValue[]>, key: TKey): TValue[] {
  const existing = map.get(key);
  if (existing) return existing;
  const created: TValue[] = [];
  map.set(key, created);
  return created;
}

function getOrCreateMethodBuckets<TState, TReq, TRes>(
  map: Map<RouteMethod, Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]>>,
  method: RouteMethod
): Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]> {
  const existing = map.get(method);
  if (existing) return existing;
  const created = new Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]>();
  map.set(method, created);
  return created;
}

function collectPathPrefixBases(path: string): string[] {
  const bases = new Set<string>();
  let slashIndex = path.indexOf("/");
  while (slashIndex !== -1) {
    bases.add(path.slice(0, slashIndex + 1));
    slashIndex = path.indexOf("/", slashIndex + 1);
  }
  bases.add(`${path}/`);
  return Array.from(bases);
}

export function createRouter<TState = SharedState, TReq = unknown, TRes = unknown>(): Router<TState, TReq, TRes> {
  const entries: IndexedRouteDefinition<TState, TReq, TRes>[] = [];
  const exactRoutes = new Map<RouteMethod, Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]>>();
  const prefixRoutes = new Map<RouteMethod, Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]>>();

  function add(
    method: RouteMethod,
    pattern: string,
    handler: RouteHandler<TState, TReq, TRes>,
    description?: string
  ): void {
    const route: IndexedRouteDefinition<TState, TReq, TRes> = {
      method,
      pattern,
      handler,
      description,
      order: entries.length,
      prefixBase: normalizePrefixBase(pattern),
    };
    entries.push(route);
    if (route.prefixBase) {
      getOrCreateBucket(
        getOrCreateMethodBuckets(prefixRoutes, method),
        route.prefixBase
      ).push(route);
      return;
    }
    getOrCreateBucket(getOrCreateMethodBuckets(exactRoutes, method), pattern).push(route);
  }

  function pickEarlierRoute(
    current: IndexedRouteDefinition<TState, TReq, TRes> | undefined,
    candidate: IndexedRouteDefinition<TState, TReq, TRes>
  ): IndexedRouteDefinition<TState, TReq, TRes> {
    if (!current) return candidate;
    return candidate.order < current.order ? candidate : current;
  }

  function matchFromBuckets(
    routeBuckets: Map<RouteMethod, Map<string, IndexedRouteDefinition<TState, TReq, TRes>[]>>,
    method: string,
    key: string,
    current: IndexedRouteDefinition<TState, TReq, TRes> | undefined
  ): IndexedRouteDefinition<TState, TReq, TRes> | undefined {
    const methodBuckets = routeBuckets.get(method as RouteMethod);
    const wildcardBuckets = routeBuckets.get("*");
    for (const candidate of methodBuckets?.get(key) ?? []) {
      current = pickEarlierRoute(current, candidate);
    }
    for (const candidate of wildcardBuckets?.get(key) ?? []) {
      current = pickEarlierRoute(current, candidate);
    }
    return current;
  }

  function match(method: string, path: string): RouteDefinition<TState, TReq, TRes> | undefined {
    const normalizedMethod = method.toUpperCase();
    let matched = matchFromBuckets(exactRoutes, normalizedMethod, path, undefined);
    for (const base of collectPathPrefixBases(path)) {
      matched = matchFromBuckets(prefixRoutes, normalizedMethod, base, matched);
    }
    return matched;
  }

  function routes(): readonly RouteDefinition<TState, TReq, TRes>[] {
    return entries;
  }

  return { add, match, routes };
}
