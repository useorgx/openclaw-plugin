import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildOrgxHeaders } from '@/lib/http';

type EntityType = 'initiative' | 'workstream' | 'milestone' | 'task' | 'decision';

type EntityComment = {
  id: string;
  parent_comment_id: string | null;
  author_type: 'human' | 'agent' | 'system';
  author_id: string;
  author_name: string | null;
  body: string;
  comment_type: string;
  severity: string;
  tags: string[] | null;
  created_at: string;
};

type ListResponse = {
  status: 'success' | 'error';
  comments: EntityComment[];
  nextCursor: string | null;
};

type CreateResponse = {
  status: 'success' | 'error';
  comment?: EntityComment;
};

function formatRelativeTime(input: string): string | null {
  const ts = Date.parse(input);
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const min = Math.round(abs / 60_000);
  if (min < 1) return future ? 'soon' : 'just now';
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;

  const hr = Math.round(abs / 3_600_000);
  if (hr < 48) return future ? `in ${hr}h` : `${hr}h ago`;

  const day = Math.round(abs / 86_400_000);
  if (day < 30) return future ? `in ${day}d` : `${day}d ago`;

  return new Date(ts).toLocaleDateString();
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      (typeof body?.error === 'string' && body.error) ||
      (typeof body?.message === 'string' && body.message) ||
      `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function EntityCommentsPanel(props: {
  entityType: EntityType;
  entityId: string;
  authToken?: string | null;
  embedMode?: boolean;
  className?: string;
}) {
  const { entityType, entityId, authToken, embedMode, className } = props;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<EntityComment[]>([]);
  const [body, setBody] = useState('');

  const endpoint = useMemo(() => {
    const type = encodeURIComponent(entityType);
    const id = encodeURIComponent(entityId);
    return `/orgx/api/entities/${type}/${id}/comments`;
  }, [entityType, entityId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchJson<ListResponse>(endpoint, {
        method: 'GET',
        headers: buildOrgxHeaders({ authToken, embedMode }),
      });
      setComments(Array.isArray(res.comments) ? res.comments : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [authToken, embedMode, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmit = useCallback(async () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await fetchJson<CreateResponse>(endpoint, {
        method: 'POST',
        headers: buildOrgxHeaders({
          authToken,
          embedMode,
          contentTypeJson: true,
        }),
        body: JSON.stringify({
          body: trimmed,
          commentType: 'note',
          severity: 'info',
          tags: [],
        }),
      });
      setBody('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [authToken, body, embedMode, endpoint, load]);

  const onTextareaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      void onSubmit();
    },
    [onSubmit]
  );

  return (
    <div className={className}>
      <div className="space-y-2">
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onTextareaKeyDown}
          placeholder="Leave a note for humans or agents..."
          className="min-h-[96px] w-full resize-y rounded-xl border border-white/[0.10] bg-white/[0.03] px-4 py-3 text-[12px] text-white/90 outline-none placeholder:text-white/25 focus:border-white/20 focus:bg-white/[0.05] transition-colors"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-white/40">
            Visible to agents and collaborators. Tip: Cmd/Ctrl+Enter to post.
          </p>
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving || body.trim().length === 0}
            className="inline-flex items-center justify-center rounded-full border border-white/[0.14] bg-white/[0.05] px-3.5 py-1.5 text-[11px] font-semibold tracking-wide text-white/80 transition-colors hover:bg-white/[0.09] disabled:opacity-50 disabled:hover:bg-white/[0.05]"
          >
            {saving ? 'Saving…' : 'Post note'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2 text-[12px] text-red-200">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-3 text-[12px] text-white/40">Loading notes…</div>
      ) : comments.length === 0 ? (
        <div className="mt-3 text-[12px] text-white/40">No notes yet.</div>
      ) : (
        <div className="mt-3 space-y-3">
          {comments.map((comment) => {
            const createdAtLabel = comment.created_at
              ? formatRelativeTime(comment.created_at)
              : null;
            const authorLabel =
              comment.author_name ??
              (comment.author_type === 'agent' ? comment.author_id : 'Unknown');
            const typeLabel = comment.comment_type ?? 'note';
            const severity = typeof comment.severity === 'string' ? comment.severity : 'info';

            return (
              <div
                key={comment.id}
                className="rounded-2xl border border-white/[0.10] bg-white/[0.02] px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-semibold text-white/90">
                      {authorLabel}
                    </span>
                    <span className="rounded-full border border-white/[0.14] bg-white/[0.06] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-white/60">
                      {comment.author_type}
                    </span>
                    <span className="rounded-full border border-white/[0.14] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-white/55">
                      {typeLabel}
                    </span>
                    {severity !== 'info' ? (
                      <span className="rounded-full border border-white/[0.14] px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-white/55">
                        {severity}
                      </span>
                    ) : null}
                  </div>
                  {createdAtLabel ? (
                    <span className="text-[11px] text-white/40">
                      {createdAtLabel}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-white/75">
                  {comment.body}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
