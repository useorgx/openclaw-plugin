import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildOrgxHeaders } from '@/lib/http';
import { formatAbsoluteTime } from '@/lib/time';
import { isDemoModeEnabled } from '@/lib/initiativeIds';

type EntityType = 'initiative' | 'workstream' | 'milestone' | 'task' | 'decision' | 'slice_run' | 'run';

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
  variant?: 'default' | 'inline';
}) {
  const { entityType, entityId, authToken, embedMode, className, variant = 'default' } = props;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<EntityComment[]>([]);
  const [body, setBody] = useState('');
  const demoMode = isDemoModeEnabled();

  const endpoint = useMemo(() => {
    const type = encodeURIComponent(entityType);
    const id = encodeURIComponent(entityId);
    return `/orgx/api/entities/${type}/${id}/comments`;
  }, [entityType, entityId]);

  const load = useCallback(async () => {
    if (demoMode) {
      setComments([]);
      setError(null);
      setLoading(false);
      return;
    }
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
  }, [authToken, demoMode, embedMode, endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmit = useCallback(async () => {
    if (demoMode) {
      setBody('');
      return;
    }
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
  }, [authToken, body, demoMode, embedMode, endpoint, load]);

  const onTextareaKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Enter') return;
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      void onSubmit();
    },
    [onSubmit]
  );

  const isInline = variant === 'inline';

  return (
    <div className={className}>
      <div className={isInline ? 'space-y-1' : 'space-y-2'}>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={onTextareaKeyDown}
          placeholder="Leave a note for humans or agents..."
          className={
            isInline
              ? 'min-h-[60px] w-full resize-y border-b border-white/[0.06] bg-transparent px-0 py-2 text-body text-bright outline-none placeholder:text-faint focus:border-white/15 transition-colors'
              : 'min-h-[96px] w-full resize-y rounded-xl border border-white/[0.10] bg-white/[0.03] px-4 py-3 text-body text-bright outline-none placeholder:text-faint focus:border-white/20 focus:bg-white/[0.05] transition-colors'
          }
        />
        <div className={`flex flex-wrap items-center justify-between gap-3 ${isInline ? 'opacity-70' : ''}`}>
          <p className="text-caption text-muted">
            Cmd/Ctrl+Enter to post. Visible to agents and collaborators.
          </p>
          <button
            type="button"
            onClick={onSubmit}
            disabled={saving || body.trim().length === 0}
            className={
              isInline
                ? 'text-caption font-semibold text-primary hover:text-white transition-colors disabled:opacity-50'
                : 'inline-flex items-center justify-center rounded-full border border-strong bg-white/[0.05] px-3.5 py-1.5 text-caption font-semibold tracking-wide text-primary transition-colors hover:bg-white/[0.09] disabled:opacity-50 disabled:hover:bg-white/[0.05]'
            }
          >
            {saving ? 'Saving…' : 'Post note'}
          </button>
        </div>
      </div>

      {error ? (
        <div className={`mt-2 text-caption text-red-200 ${isInline ? '' : 'rounded-xl border border-red-500/20 bg-red-500/10 px-3.5 py-2'}`}>
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-2 text-body text-muted">Loading notes…</div>
      ) : comments.length === 0 ? (
        <div className="mt-2 text-body text-muted">
          {demoMode ? 'Notes are unavailable in demo mode.' : 'No notes yet.'}
        </div>
      ) : (
        <div className={`mt-2 ${isInline ? 'space-y-2 divide-y divide-white/[0.06]' : 'space-y-3'}`}>
          {comments.map((comment) => {
            const createdAtLabel = comment.created_at
              ? formatRelativeTime(comment.created_at)
              : null;
            const authorLabel =
              comment.author_name ??
              (comment.author_type === 'agent' ? comment.author_id : 'Unknown');
            if (isInline) {
              return (
                <div key={comment.id} className="pt-2 first:pt-0">
                  <div className="flex items-center gap-2 text-micro text-muted">
                    <span className="font-medium text-secondary">{authorLabel}</span>
                    {createdAtLabel ? (
                      <span title={formatAbsoluteTime(comment.created_at)}>{createdAtLabel}</span>
                    ) : null}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-body leading-relaxed text-primary">
                    {comment.body}
                  </p>
                </div>
              );
            }
            const typeLabel = comment.comment_type ?? 'note';
            const severity = typeof comment.severity === 'string' ? comment.severity : 'info';

            return (
              <div
                key={comment.id}
                className="rounded-2xl border border-white/[0.10] bg-white/[0.02] px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-body font-semibold text-bright">
                      {authorLabel}
                    </span>
                    <span className="rounded-full border border-strong bg-white/[0.06] px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                      {comment.author_type}
                    </span>
                    <span className="rounded-full border border-strong px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                      {typeLabel}
                    </span>
                    {severity !== 'info' ? (
                      <span className="rounded-full border border-strong px-2 py-0.5 text-micro uppercase tracking-[0.08em] text-secondary">
                        {severity}
                      </span>
                    ) : null}
                  </div>
                  {createdAtLabel ? (
                    <span className="text-caption text-muted" title={formatAbsoluteTime(comment.created_at)}>
                      {createdAtLabel}
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-body leading-relaxed text-primary">
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
