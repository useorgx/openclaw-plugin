import { useEffect, useMemo, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Modal } from '@/components/shared/Modal';
import { colors, motion as motionTokens } from '@/lib/tokens';
import { queryKeys } from '@/lib/queryKeys';
import { buildOrgxHeaders } from '@/lib/http';
import { useArtifactViewer } from './ArtifactViewerContext';
import { Skeleton } from '@/components/shared/Skeleton';
import { Pill } from '@/components/shared/Pill';

/* ────────────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────────────── */

interface ArtifactData {
  id: string;
  name: string;
  description: string | null;
  artifact_url: string;
  artifact_type: string;
  status: string;
  version: number;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  catalog?: {
    label: string;
    domain: string;
    stage: string;
  } | null;
  cached_metadata?: {
    title?: string;
    description?: string;
    thumbnail_url?: string;
  } | null;
}

interface ArtifactDetailResponse {
  artifact: ArtifactData;
  relationships: Array<{
    id: string;
    to_artifact_id: string;
    relationship_type: string;
  }>;
  localFallback?: boolean;
  warning?: string | null;
}

/* ────────────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────────────── */

const PREVIEW_LINE_COUNT = 15;

const statusColors: Record<string, string> = {
  draft: colors.textMuted,
  in_review: colors.amber,
  approved: colors.lime,
  changes_requested: colors.red,
  superseded: colors.textMuted,
  archived: colors.textMuted,
};

const statusLabels: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  approved: 'Approved',
  changes_requested: 'Changes Requested',
  superseded: 'Superseded',
  archived: 'Archived',
};

const springTransition = {
  type: 'spring' as const,
  stiffness: motionTokens.easingSpring.stiffness,
  damping: motionTokens.easingSpring.damping,
};

/* ────────────────────────────────────────────────────────────────────
 * Language detection
 * ──────────────────────────────────────────────────────────────────── */

function detectLanguage(
  content: string,
  artifactType?: string,
  name?: string
): string {
  // 1. Check artifact type
  if (artifactType) {
    const t = artifactType.toLowerCase();
    if (t.includes('typescript') || t.includes('.ts')) return 'typescript';
    if (t.includes('javascript') || t.includes('.js')) return 'typescript';
    if (t.includes('json') || t.includes('schema')) return 'json';
    if (t.includes('yaml') || t.includes('yml')) return 'yaml';
    if (t.includes('markdown') || t.includes('.md')) return 'markdown';
  }

  // 2. Check file extension in name
  if (name) {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') return 'typescript';
    if (ext === 'json') return 'json';
    if (ext === 'yaml' || ext === 'yml') return 'yaml';
    if (ext === 'md' || ext === 'mdx') return 'markdown';
  }

  // 3. Content sniffing
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  if (trimmed.startsWith('---')) return 'yaml';
  if (trimmed.startsWith('#') && /^#{1,6}\s/.test(trimmed)) return 'markdown';

  // 4. Heuristic: keywords
  if (/\b(import|export|const|function|interface|type)\b/.test(trimmed.slice(0, 500)))
    return 'typescript';
  if (/^[\w-]+:\s/m.test(trimmed.slice(0, 500))) return 'yaml';

  return 'plain';
}

/* ────────────────────────────────────────────────────────────────────
 * Lightweight syntax tokenizer (~70 lines)
 * ──────────────────────────────────────────────────────────────────── */

interface Token {
  type: 'keyword' | 'string' | 'number' | 'comment' | 'punctuation' | 'key' | 'heading' | 'bold' | 'italic' | 'code' | 'link' | 'boolean' | 'null' | 'plain';
  value: string;
}

const TS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'import', 'export', 'from', 'class', 'interface', 'type', 'extends', 'implements',
  'new', 'this', 'super', 'async', 'await', 'try', 'catch', 'finally', 'throw',
  'default', 'switch', 'case', 'break', 'continue', 'do', 'of', 'in', 'typeof',
  'instanceof', 'void', 'null', 'undefined', 'true', 'false', 'as', 'is',
]);

function tokenizeJSON(code: string): Token[] {
  const tokens: Token[] = [];
  const re = /("(?:[^"\\]|\\.)*")\s*(:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}[\],])|(\s+)|([^\s"{}[\],:]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[1]) {
      tokens.push({ type: m[2] ? 'key' : 'string', value: m[1] });
      if (m[2]) tokens.push({ type: 'punctuation', value: ':' });
    } else if (m[3]) {
      tokens.push({ type: 'number', value: m[3] });
    } else if (m[4]) {
      tokens.push({ type: 'boolean', value: m[4] });
    } else if (m[5]) {
      tokens.push({ type: 'null', value: m[5] });
    } else if (m[6]) {
      tokens.push({ type: 'punctuation', value: m[6] });
    } else {
      tokens.push({ type: 'plain', value: m[0] });
    }
  }
  return tokens;
}

function tokenizeYAML(code: string): Token[] {
  const tokens: Token[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tokens.push({ type: 'plain', value: '\n' });
    const line = lines[i];
    if (line.trimStart().startsWith('#')) {
      tokens.push({ type: 'comment', value: line });
      continue;
    }
    const keyMatch = line.match(/^(\s*)([\w.-]+)(\s*:\s*)(.*)/);
    if (keyMatch) {
      if (keyMatch[1]) tokens.push({ type: 'plain', value: keyMatch[1] });
      tokens.push({ type: 'key', value: keyMatch[2] });
      tokens.push({ type: 'punctuation', value: keyMatch[3] });
      const val = keyMatch[4];
      if (/^(true|false|yes|no|on|off)$/i.test(val.trim())) {
        tokens.push({ type: 'boolean', value: val });
      } else if (/^-?\d+(\.\d+)?$/.test(val.trim())) {
        tokens.push({ type: 'number', value: val });
      } else if (/^['"]/.test(val.trim())) {
        tokens.push({ type: 'string', value: val });
      } else if (val.trim() === 'null' || val.trim() === '~') {
        tokens.push({ type: 'null', value: val });
      } else {
        tokens.push({ type: 'string', value: val });
      }
    } else {
      tokens.push({ type: 'plain', value: line });
    }
  }
  return tokens;
}

function tokenizeTypeScript(code: string): Token[] {
  const tokens: Token[] = [];
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\b[a-zA-Z_$][\w$]*\b)|([{}()[\];,.:?!<>=+\-*/&|^~%@#]+)|(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (m[1]) {
      tokens.push({ type: 'comment', value: m[1] });
    } else if (m[2]) {
      tokens.push({ type: 'string', value: m[2] });
    } else if (m[3]) {
      tokens.push({ type: 'number', value: m[3] });
    } else if (m[4]) {
      if (TS_KEYWORDS.has(m[4])) {
        tokens.push({ type: 'keyword', value: m[4] });
      } else if (m[4] === 'true' || m[4] === 'false') {
        tokens.push({ type: 'boolean', value: m[4] });
      } else {
        tokens.push({ type: 'plain', value: m[4] });
      }
    } else if (m[5]) {
      tokens.push({ type: 'punctuation', value: m[5] });
    } else {
      tokens.push({ type: 'plain', value: m[0] });
    }
  }
  return tokens;
}

function tokenizeMarkdown(code: string): Token[] {
  const tokens: Token[] = [];
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) tokens.push({ type: 'plain', value: '\n' });
    const line = lines[i];
    if (/^#{1,6}\s/.test(line)) {
      tokens.push({ type: 'heading', value: line });
    } else if (/^```/.test(line.trimStart())) {
      tokens.push({ type: 'code', value: line });
    } else {
      // Inline patterns
      const inlineRe = /(\*\*[^*]+\*\*)|(\*[^*]+\*)|(`[^`]+`)|(https?:\/\/[^\s)]+)|(\[[^\]]*\]\([^)]*\))|([^*`[\]]+)/g;
      let im: RegExpExecArray | null;
      while ((im = inlineRe.exec(line)) !== null) {
        if (im[1]) tokens.push({ type: 'bold', value: im[1] });
        else if (im[2]) tokens.push({ type: 'italic', value: im[2] });
        else if (im[3]) tokens.push({ type: 'code', value: im[3] });
        else if (im[4]) tokens.push({ type: 'link', value: im[4] });
        else if (im[5]) tokens.push({ type: 'link', value: im[5] });
        else tokens.push({ type: 'plain', value: im[0] });
      }
    }
  }
  return tokens;
}

function tokenize(code: string, lang: string): Token[] {
  switch (lang) {
    case 'json':
      return tokenizeJSON(code);
    case 'yaml':
      return tokenizeYAML(code);
    case 'typescript':
      return tokenizeTypeScript(code);
    case 'markdown':
      return tokenizeMarkdown(code);
    default:
      return [{ type: 'plain', value: code }];
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Token color mapping
 * ──────────────────────────────────────────────────────────────────── */

function getTokenColor(type: Token['type'], agentColor: string | null): string {
  const kw = agentColor || colors.lime;
  switch (type) {
    case 'keyword':
      return kw;
    case 'key':
      return kw;
    case 'string':
      return colors.teal;
    case 'number':
      return colors.amber;
    case 'boolean':
      return colors.amber;
    case 'null':
      return colors.red;
    case 'comment':
      return 'rgba(255,255,255,0.40)';
    case 'punctuation':
      return 'rgba(255,255,255,0.60)';
    case 'heading':
      return colors.iris;
    case 'bold':
      return colors.text;
    case 'italic':
      return 'rgba(255,255,255,0.75)';
    case 'code':
      return colors.cyan;
    case 'link':
      return colors.cyan;
    case 'plain':
    default:
      return 'rgba(255,255,255,0.85)';
  }
}

function getTokenFontWeight(type: Token['type']): number | undefined {
  if (type === 'keyword' || type === 'heading' || type === 'bold' || type === 'key')
    return 600;
  return undefined;
}

function getTokenFontStyle(type: Token['type']): string | undefined {
  if (type === 'italic' || type === 'comment') return 'italic';
  return undefined;
}

/* ────────────────────────────────────────────────────────────────────
 * Syntax-highlighted code block component
 * ──────────────────────────────────────────────────────────────────── */

function SyntaxBlock({
  code,
  language,
  agentColor,
  maxLines,
  expanded,
}: {
  code: string;
  language: string;
  agentColor: string | null;
  maxLines?: number;
  expanded: boolean;
}) {
  const lines = code.split('\n');
  const isTruncated = !expanded && maxLines != null && lines.length > maxLines;
  const visibleCode = isTruncated ? lines.slice(0, maxLines).join('\n') : code;
  const tokens = useMemo(
    () => tokenize(visibleCode, language),
    [visibleCode, language]
  );

  return (
    <div className="relative">
      <pre className="font-mono text-[13px] leading-relaxed overflow-x-auto p-4 m-0 whitespace-pre-wrap break-words">
        <code>
          {tokens.map((tok, i) => (
            <span
              key={i}
              style={{
                color: getTokenColor(tok.type, agentColor),
                fontWeight: getTokenFontWeight(tok.type),
                fontStyle: getTokenFontStyle(tok.type),
              }}
            >
              {tok.value}
            </span>
          ))}
        </code>
      </pre>
      {/* Gradient fade at bottom of truncated view */}
      {isTruncated && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#08090D] to-transparent" />
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Copy button with checkmark animation
 * ──────────────────────────────────────────────────────────────────── */

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Silently fail
    }
  }, [text]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="relative flex items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-micro font-medium text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
      title="Copy content"
    >
      <div className="relative h-3.5 w-3.5">
        <AnimatePresence mode="wait" initial={false}>
          {copied ? (
            <motion.svg
              key="check"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke={colors.lime}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="absolute inset-0"
            >
              <motion.path
                d="M20 6 9 17l-5-5"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              />
            </motion.svg>
          ) : (
            <motion.svg
              key="copy"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ opacity: 0, scale: 0.5 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.15 }}
              className="absolute inset-0"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" />
              <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
            </motion.svg>
          )}
        </AnimatePresence>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        {copied ? (
          <motion.span
            key="label-copied"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
            style={{ color: colors.lime }}
          >
            Copied
          </motion.span>
        ) : (
          <motion.span
            key="label-copy"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.15 }}
          >
            Copy
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Icons
 * ──────────────────────────────────────────────────────────────────── */

function ArtifactIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke={colors.cyan}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 9H8" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
    </svg>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Provenance display
 * ──────────────────────────────────────────────────────────────────── */

function ProvenanceBar({
  metadata,
  agentColor,
  createdAt,
}: {
  metadata: Record<string, unknown>;
  agentColor: string | null;
  createdAt: string;
}) {
  const agentName =
    (typeof metadata.agent_name === 'string' && metadata.agent_name) ||
    (typeof metadata.agent === 'string' && metadata.agent) ||
    (typeof metadata.produced_by === 'string' && metadata.produced_by) ||
    null;
  const taskRef =
    (typeof metadata.task_id === 'string' && metadata.task_id) ||
    (typeof metadata.run_ref === 'string' && metadata.run_ref) ||
    (typeof metadata.queue_ref === 'string' && metadata.queue_ref) ||
    null;

  if (!agentName && !taskRef) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 text-micro text-faint">
      {agentName && (
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: agentColor || colors.textMuted }}
          />
          <span className="font-medium" style={{ color: agentColor || colors.textMuted }}>
            {agentName}
          </span>
        </span>
      )}
      {taskRef && (
        <span className="truncate max-w-[200px] opacity-70" title={taskRef}>
          {taskRef.length > 20 ? `${taskRef.slice(0, 8)}...` : taskRef}
        </span>
      )}
      <span className="opacity-60">
        {new Date(createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Main Modal Component
 * ──────────────────────────────────────────────────────────────────── */

export function ArtifactViewerModal() {
  const { state, close, setContentMeta } = useArtifactViewer();
  const authToken: string | null = null;
  const embedMode = false;
  const [expanded, setExpanded] = useState(false);

  // Reset expanded state when artifact changes
  useEffect(() => {
    setExpanded(false);
  }, [state.artifactId]);

  const { data, isLoading, isFetching, error, refetch } = useQuery<ArtifactDetailResponse>({
    queryKey: queryKeys.artifactDetail({
      artifactId: state.artifactId ?? '',
      authToken,
      embedMode,
    }),
    enabled: Boolean(state.artifactId),
    queryFn: async () => {
      const headers = buildOrgxHeaders({ authToken, embedMode });
      const response = await fetch(
        `/orgx/api/artifacts/${encodeURIComponent(state.artifactId!)}`,
        { headers }
      );
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as
          | {
              error?: string | { code?: string; message?: string };
              message?: string;
            }
          | null;
        const errorText =
          (typeof payload?.error === 'string' ? payload.error : null) ??
          (payload?.error &&
          typeof payload.error === 'object' &&
          typeof payload.error.message === 'string'
            ? payload.error.message
            : null) ??
          (typeof payload?.message === 'string' ? payload.message : null);
        const fallback =
          response.status === 401
            ? 'Authentication required to view this artifact.'
            : `Failed to fetch artifact (${response.status}).`;
        throw new Error(errorText?.trim().length ? errorText.trim() : fallback);
      }
      return response.json();
    },
  });

  const artifact = data?.artifact;

  // Extract content blob from metadata
  const contentBlob = useMemo(() => {
    if (state.contentBlob) return state.contentBlob;
    if (!artifact?.metadata) return null;
    const candidates = [
      artifact.metadata.content,
      artifact.metadata.body,
      artifact.metadata.code,
      artifact.metadata.source,
      artifact.metadata.text,
      artifact.metadata.preview_markdown,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim().length > 0) return c;
    }
    // Try serializing structured metadata as JSON
    if (artifact.metadata.output && typeof artifact.metadata.output === 'object') {
      try {
        return JSON.stringify(artifact.metadata.output, null, 2);
      } catch {
        /* ignore */
      }
    }
    return null;
  }, [artifact?.metadata, state.contentBlob]);

  // Detect language
  const detectedLang = useMemo(() => {
    if (state.detectedLanguage) return state.detectedLanguage;
    if (!contentBlob) return 'plain';
    return detectLanguage(contentBlob, artifact?.artifact_type, artifact?.name);
  }, [contentBlob, artifact?.artifact_type, artifact?.name, state.detectedLanguage]);

  // Agent color from context or metadata
  const agentColor = useMemo(() => {
    if (state.agentColor) return state.agentColor;
    const meta = artifact?.metadata;
    if (!meta) return null;
    const agentName =
      (typeof meta.agent_name === 'string' && meta.agent_name) ||
      (typeof meta.agent === 'string' && meta.agent) ||
      (typeof meta.produced_by === 'string' && meta.produced_by) ||
      null;
    if (!agentName) return null;
    // Try to look up from well-known agents
    const knownColors: Record<string, string> = {
      Pace: '#7C7CFF',
      Eli: '#BFFF00',
      Dana: '#FF00D4',
      Mark: '#F5B700',
      System: '#14B8A6',
      Sage: '#0AD4C4',
      Orion: '#14B8A6',
      Xandy: '#FF6B88',
      Nova: '#A78BFA',
    };
    return knownColors[agentName] || null;
  }, [artifact?.metadata, state.agentColor]);

  // Push detected content meta back to context
  useEffect(() => {
    if (contentBlob || detectedLang !== 'plain' || agentColor) {
      setContentMeta({
        contentBlob,
        detectedLanguage: detectedLang,
        agentColor,
      });
    }
  }, [contentBlob, detectedLang, agentColor, setContentMeta]);

  const isLocalFallback =
    data?.localFallback === true ||
    (artifact?.metadata?.local_fallback as boolean | undefined) === true;
  const localFallbackWarning =
    (typeof data?.warning === 'string' && data.warning.trim().length > 0
      ? data.warning
      : (artifact?.metadata?.local_warning as string | undefined)) ?? null;
  const previewMarkdown =
    (artifact?.metadata?.preview_markdown as string) ?? null;
  const fallbackSourcePath = useMemo(() => {
    if (!artifact?.metadata) return null;
    const candidates = [
      artifact.metadata.local_source_path,
      artifact.metadata.url,
      artifact.metadata.path,
      artifact.metadata.file_path,
      artifact.metadata.filepath,
      artifact.metadata.artifact_path,
      artifact.metadata.output_path,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return null;
  }, [artifact?.metadata]);
  const fallbackSourceHref = useMemo(() => {
    if (!fallbackSourcePath) return null;
    if (/^https?:\/\//i.test(fallbackSourcePath)) return fallbackSourcePath;
    return `/orgx/api/live/filesystem/open?path=${encodeURIComponent(fallbackSourcePath)}`;
  }, [fallbackSourcePath]);
  const externalUrl =
    (artifact?.metadata?.external_url as string) ?? artifact?.artifact_url;

  // Line count for "View Full" toggle
  const totalLines = contentBlob ? contentBlob.split('\n').length : 0;
  const showExpandToggle = totalLines > PREVIEW_LINE_COUNT;

  // Language label for display
  const langLabel = useMemo(() => {
    const labels: Record<string, string> = {
      json: 'JSON',
      yaml: 'YAML',
      markdown: 'Markdown',
      typescript: 'TypeScript',
      plain: 'Plain Text',
    };
    return labels[detectedLang] || detectedLang;
  }, [detectedLang]);

  return (
    <Modal open={Boolean(state.artifactId)} onClose={close} maxWidth="max-w-3xl">
      {isLoading && (
        <div className="p-6 space-y-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}

      {error && (
        <div className="space-y-4 p-6">
          <div className="rounded-xl border border-red-300/22 bg-red-500/[0.08] p-4">
            <p className="text-body font-semibold text-red-200">Failed to load artifact</p>
            <p className="mt-1 text-caption leading-relaxed text-red-100/80">{error.message}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption font-semibold text-primary transition-colors hover:bg-white/[0.08]"
            >
              Back to activity
            </button>
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="rounded-full border border-red-300/22 bg-red-500/[0.08] px-3 py-1.5 text-caption font-semibold text-red-100 transition-colors hover:bg-red-500/[0.14] disabled:opacity-45"
            >
              {isFetching ? 'Retrying...' : 'Retry'}
            </button>
          </div>
        </div>
      )}

      {artifact && (
        <>
          {/* Header */}
          <div className="flex items-center justify-between border-b border-subtle px-5 py-4 sm:px-6">
            <div className="flex items-center gap-3 min-w-0">
              <ArtifactIcon />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-medium text-white">
                  {artifact.name}
                </h3>
                <div className="flex items-center gap-2 mt-0.5">
                  <Pill tone="muted" className="text-micro uppercase tracking-[0.06em]">
                    {artifact.catalog?.label ?? artifact.artifact_type}
                  </Pill>
                  <Pill
                    tone="neutral"
                    className="text-micro font-semibold uppercase tracking-[0.06em]"
                    style={{
                      color: statusColors[artifact.status] ?? colors.textMuted,
                      backgroundColor: `${statusColors[artifact.status] ?? colors.textMuted}20`,
                      borderColor: `${statusColors[artifact.status] ?? colors.textMuted}44`,
                    }}
                  >
                    {statusLabels[artifact.status] ?? artifact.status}
                  </Pill>
                  {contentBlob && (
                    <span className="text-micro text-faint">
                      {langLabel} · {totalLines} line{totalLines !== 1 ? 's' : ''}
                    </span>
                  )}
                  {artifact.catalog?.domain && (
                    <span className="text-micro text-faint">
                      {artifact.catalog.domain} / {artifact.catalog.stage}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {contentBlob && <CopyButton text={contentBlob} />}
              {externalUrl && (
                <a
                  href={externalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-lg p-2 text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
                  title="Open source"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  </svg>
                </a>
              )}
              <button
                onClick={close}
                className="p-2 rounded-lg hover:bg-white/[0.06] text-secondary hover:text-white transition-colors"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[65vh] overflow-y-auto px-5 py-4 sm:px-6 space-y-4">
            {/* Local fallback warning */}
            {isLocalFallback && (
              <div className="rounded-xl border border-amber-300/25 bg-amber-500/[0.09] p-4">
                <p className="text-caption font-semibold uppercase tracking-[0.08em] text-amber-100/90">
                  Local fallback artifact
                </p>
                <p className="mt-1 text-body text-amber-50/90">
                  This artifact is buffered locally because OrgX registration is currently unavailable.
                </p>
                {localFallbackWarning && (
                  <p className="mt-1.5 text-caption text-amber-100/70">
                    Upstream error: {localFallbackWarning}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {fallbackSourceHref && (
                    <a
                      href={fallbackSourceHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rounded-full border border-amber-200/25 bg-black/25 px-3 py-1 text-caption font-semibold text-amber-100 transition-colors hover:bg-black/35"
                    >
                      Open local artifact
                    </a>
                  )}
                  {fallbackSourcePath && (
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(fallbackSourcePath)}
                      className="rounded-full border border-amber-200/25 bg-black/20 px-3 py-1 text-caption font-semibold text-amber-100 transition-colors hover:bg-black/35"
                    >
                      Copy path
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Provenance bar */}
            {artifact.metadata && (
              <ProvenanceBar
                metadata={artifact.metadata}
                agentColor={agentColor}
                createdAt={artifact.created_at}
              />
            )}

            {/* Description */}
            {artifact.description && (
              <div>
                <p className="text-body leading-relaxed text-primary">
                  {artifact.description}
                </p>
              </div>
            )}

            {/* Syntax-highlighted content block */}
            {contentBlob && (
              <div className="rounded-xl border border-white/[0.06] bg-[#08090D] overflow-hidden">
                {/* Code toolbar */}
                <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2">
                  <span className="text-micro font-medium text-faint uppercase tracking-wider">
                    {langLabel}
                  </span>
                  <CopyButton text={contentBlob} />
                </div>

                {/* Animated code block with spring expand */}
                <motion.div
                  initial={false}
                  animate={{
                    height: expanded || !showExpandToggle ? 'auto' : `${PREVIEW_LINE_COUNT * 22 + 32}px`,
                  }}
                  transition={springTransition}
                  className="overflow-hidden"
                >
                  <SyntaxBlock
                    code={contentBlob}
                    language={detectedLang}
                    agentColor={agentColor}
                    maxLines={PREVIEW_LINE_COUNT}
                    expanded={expanded}
                  />
                </motion.div>

                {/* View Full / Collapse toggle */}
                {showExpandToggle && (
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => !prev)}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-white/[0.06] px-4 py-2.5 text-micro font-semibold transition-colors hover:bg-white/[0.04]"
                    style={{ color: agentColor || colors.cyan }}
                  >
                    <motion.svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      animate={{ rotate: expanded ? 180 : 0 }}
                      transition={{ duration: 0.22 }}
                    >
                      <path d="m6 9 6 6 6-6" />
                    </motion.svg>
                    {expanded
                      ? 'Collapse'
                      : `View Full (${totalLines} lines)`}
                  </button>
                )}
              </div>
            )}

            {/* Fallback: no content but has preview markdown */}
            {!contentBlob && previewMarkdown && (
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <pre className="font-mono text-[13px] leading-relaxed text-primary whitespace-pre-wrap break-words">
                  {previewMarkdown}
                </pre>
              </div>
            )}

            {/* No preview at all */}
            {!artifact.description && !contentBlob && !previewMarkdown && (
              <div className="py-12 text-center text-muted">
                <svg
                  className="mx-auto mb-3 opacity-50"
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
                  <path d="M14 2v4a2 2 0 0 0 2 2h4" />
                </svg>
                <p className="text-sm">No preview available</p>
              </div>
            )}

            {/* Metadata details */}
            <div className="flex flex-wrap gap-x-6 gap-y-1.5 text-micro text-faint">
              <span>Entity: {artifact.entity_type}/{artifact.entity_id.slice(0, 8)}</span>
              <span>Version: {artifact.version}</span>
              <span>
                Updated:{' '}
                {new Date(artifact.updated_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}
