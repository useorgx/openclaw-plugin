import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import { getOrgxPluginConfigDir, getOrgxPluginConfigPath } from "./paths.js";
import { backupCorruptFileSync, writeJsonFileAtomicSync } from "./fs-utils.js";

export type EntityCommentAuthorType = "human" | "agent" | "system";

export type EntityCommentRecord = {
  id: string;
  parent_comment_id: string | null;
  author_type: EntityCommentAuthorType;
  author_id: string;
  author_name: string | null;
  body: string;
  comment_type: string;
  severity: string;
  tags: string[] | null;
  created_at: string;
};

type PersistedEntityComments = {
  updatedAt: string;
  commentsByEntity: Record<string, EntityCommentRecord[]>;
};

const MAX_COMMENTS_PER_ENTITY = 240;
const MAX_TOTAL_COMMENTS = 1_500;

function commentsDir(): string {
  return getOrgxPluginConfigDir();
}

function commentsFile(): string {
  return getOrgxPluginConfigPath("entity-comments.json");
}

function ensureDir(): void {
  const dir = commentsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function entityKey(entityType: string, entityId: string): string {
  return `${entityType.trim().toLowerCase()}:${entityId.trim()}`;
}

function normalizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const tags = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return tags.length > 0 ? tags.slice(0, 16) : [];
}

function normalizeComment(input: EntityCommentRecord): EntityCommentRecord {
  const createdAt = typeof input.created_at === "string" ? input.created_at : new Date().toISOString();
  return {
    id: typeof input.id === "string" && input.id.trim().length > 0 ? input.id.trim() : `local_${randomUUID()}`,
    parent_comment_id:
      typeof input.parent_comment_id === "string" && input.parent_comment_id.trim().length > 0
        ? input.parent_comment_id.trim()
        : null,
    author_type: input.author_type === "agent" || input.author_type === "system" ? input.author_type : "human",
    author_id: typeof input.author_id === "string" && input.author_id.trim().length > 0 ? input.author_id.trim() : "local_user",
    author_name: typeof input.author_name === "string" && input.author_name.trim().length > 0 ? input.author_name.trim() : null,
    body: typeof input.body === "string" ? input.body : "",
    comment_type: typeof input.comment_type === "string" && input.comment_type.trim().length > 0 ? input.comment_type.trim() : "note",
    severity: typeof input.severity === "string" && input.severity.trim().length > 0 ? input.severity.trim() : "info",
    tags: normalizeTags(input.tags) ?? [],
    created_at: createdAt,
  };
}

function readStore(): PersistedEntityComments {
  const file = commentsFile();
  try {
    if (!existsSync(file)) {
      return { updatedAt: new Date().toISOString(), commentsByEntity: {} };
    }
    const raw = readFileSync(file, "utf8");
    const parsed = parseJson<PersistedEntityComments>(raw);
    if (!parsed || typeof parsed !== "object") {
      backupCorruptFileSync(file);
      return { updatedAt: new Date().toISOString(), commentsByEntity: {} };
    }
    const commentsByEntity =
      parsed.commentsByEntity && typeof parsed.commentsByEntity === "object"
        ? (parsed.commentsByEntity as Record<string, EntityCommentRecord[]>)
        : {};
    return {
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      commentsByEntity,
    };
  } catch {
    return { updatedAt: new Date().toISOString(), commentsByEntity: {} };
  }
}

function writeStore(store: PersistedEntityComments): void {
  ensureDir();
  const file = commentsFile();
  writeJsonFileAtomicSync(file, store, 0o600);
}

function trimStore(store: PersistedEntityComments): PersistedEntityComments {
  const next: PersistedEntityComments = {
    updatedAt: store.updatedAt,
    commentsByEntity: { ...store.commentsByEntity },
  };

  for (const [key, comments] of Object.entries(next.commentsByEntity)) {
    if (!Array.isArray(comments) || comments.length === 0) {
      delete next.commentsByEntity[key];
      continue;
    }
    const normalized = comments.map((c) => normalizeComment(c));
    normalized.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    next.commentsByEntity[key] = normalized.slice(-MAX_COMMENTS_PER_ENTITY);
  }

  const all: Array<{ key: string; comment: EntityCommentRecord }> = [];
  for (const [key, comments] of Object.entries(next.commentsByEntity)) {
    for (const comment of comments) all.push({ key, comment });
  }
  if (all.length <= MAX_TOTAL_COMMENTS) return next;

  all.sort((a, b) => Date.parse(b.comment.created_at) - Date.parse(a.comment.created_at));
  const keep = all.slice(0, MAX_TOTAL_COMMENTS);
  const keepByEntity = new Map<string, EntityCommentRecord[]>();
  for (const item of keep) {
    const list = keepByEntity.get(item.key) ?? [];
    list.push(item.comment);
    keepByEntity.set(item.key, list);
  }

  const rebuilt: Record<string, EntityCommentRecord[]> = {};
  for (const [key, list] of keepByEntity.entries()) {
    list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    rebuilt[key] = list;
  }
  next.commentsByEntity = rebuilt;
  return next;
}

export function listEntityComments(entityType: string, entityId: string): EntityCommentRecord[] {
  const key = entityKey(entityType, entityId);
  const store = readStore();
  const list = store.commentsByEntity[key];
  if (!Array.isArray(list) || list.length === 0) return [];
  return list.map((c) => normalizeComment(c));
}

export function appendEntityComment(input: {
  entityType: string;
  entityId: string;
  body: string;
  commentType?: string | null;
  severity?: string | null;
  tags?: unknown;
  author?: {
    author_type?: EntityCommentAuthorType;
    author_id?: string;
    author_name?: string | null;
  };
}): EntityCommentRecord {
  const body = input.body.trim();
  if (!body) {
    throw new Error("comment body is required");
  }

  const key = entityKey(input.entityType, input.entityId);
  const now = new Date().toISOString();
  const record: EntityCommentRecord = normalizeComment({
    id: `local_${randomUUID()}`,
    parent_comment_id: null,
    author_type: input.author?.author_type ?? "human",
    author_id: input.author?.author_id ?? "local_user",
    author_name: input.author?.author_name ?? null,
    body,
    comment_type: (input.commentType ?? "note") || "note",
    severity: (input.severity ?? "info") || "info",
    tags: normalizeTags(input.tags) ?? [],
    created_at: now,
  });

  const store = readStore();
  const existing = Array.isArray(store.commentsByEntity[key]) ? store.commentsByEntity[key] : [];
  const next: PersistedEntityComments = {
    updatedAt: now,
    commentsByEntity: {
      ...store.commentsByEntity,
      [key]: [...existing, record],
    },
  };

  const trimmed = trimStore(next);
  writeStore(trimmed);
  return record;
}

export function mergeEntityComments(
  remote: unknown,
  local: EntityCommentRecord[]
): EntityCommentRecord[] {
  const remoteList = Array.isArray(remote) ? (remote as unknown[]) : [];
  const merged = new Map<string, EntityCommentRecord>();

  for (const comment of remoteList) {
    if (!comment || typeof comment !== "object") continue;
    const record = normalizeComment(comment as EntityCommentRecord);
    merged.set(record.id, record);
  }
  for (const comment of local) {
    const record = normalizeComment(comment);
    merged.set(record.id, record);
  }

  const list = Array.from(merged.values());
  list.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  return list;
}

export function clearEntityCommentsStore(): void {
  const file = commentsFile();
  try {
    rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

