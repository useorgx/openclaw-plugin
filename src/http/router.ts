import type { SharedState } from "./shared-state.js";

export type RouteMethod =
  | "GET"
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

function isPatternMatch(pattern: string, path: string): boolean {
  if (pattern.endsWith("/*")) {
    return path.startsWith(pattern.slice(0, -1));
  }
  return pattern === path;
}

export function createRouter<TState = SharedState, TReq = unknown, TRes = unknown>(): Router<TState, TReq, TRes> {
  const entries: RouteDefinition<TState, TReq, TRes>[] = [];

  function add(
    method: RouteMethod,
    pattern: string,
    handler: RouteHandler<TState, TReq, TRes>,
    description?: string
  ): void {
    entries.push({ method, pattern, handler, description });
  }

  function match(method: string, path: string): RouteDefinition<TState, TReq, TRes> | undefined {
    const normalizedMethod = method.toUpperCase();
    return entries.find((route) => {
      const methodMatches = route.method === "*" || route.method === normalizedMethod;
      return methodMatches && isPatternMatch(route.pattern, path);
    });
  }

  function routes(): readonly RouteDefinition<TState, TReq, TRes>[] {
    return entries;
  }

  return { add, match, routes };
}
