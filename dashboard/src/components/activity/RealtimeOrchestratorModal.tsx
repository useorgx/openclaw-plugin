import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/shared/Modal';

type RealtimeOrchestratorAction = {
  actionId: string;
  type: string;
  payload: Record<string, unknown>;
  reason: string;
  confidence: number;
  requiresConfirmation: boolean;
  blockingImpact: 'none' | 'low' | 'medium' | 'high';
};

type RealtimeOrchestratorResult = {
  actionId: string;
  type: string;
  ok: boolean;
  message: string;
  error?: string;
};

type RealtimeOrchestratorCommand = {
  id: string;
  status: string;
  humanSummary: string;
  riskFlags: string[];
  proposedActions: RealtimeOrchestratorAction[];
  results: RealtimeOrchestratorResult[];
};

type SessionResponse = {
  ok?: boolean;
  error?: string;
  session?: {
    model?: string;
    client_secret?: {
      value?: string;
      expires_at?: number;
    };
  };
  defaults?: {
    model?: string;
  };
};

type CommandResponse = {
  ok?: boolean;
  error?: string;
  command?: RealtimeOrchestratorCommand;
};

type RealtimeOrchestratorModalProps = {
  open: boolean;
  selectedWorkspaceId: string | null;
  onClose: () => void;
};

type ToolInvocation = {
  callId: string;
  name: string;
  arguments: string;
};

const TOOL_NAMES = {
  PREVIEW: 'orgx_orchestrator_preview',
  APPLY: 'orgx_orchestrator_apply',
  STATUS: 'orgx_orchestrator_status',
} as const;

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function extractTranscript(event: Record<string, unknown>): string | null {
  const direct =
    normalizeText(event.transcript) ??
    normalizeText(event.text) ??
    normalizeText((event.delta as string) ?? null);
  if (direct) return direct;

  const item = event.item && typeof event.item === 'object' ? (event.item as Record<string, unknown>) : null;
  const content = Array.isArray(item?.content) ? item?.content : [];
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue;
    const maybe = normalizeText((entry as Record<string, unknown>).transcript) ??
      normalizeText((entry as Record<string, unknown>).text);
    if (maybe) return maybe;
  }

  return null;
}

function extractFunctionCallsFromResponseDone(event: Record<string, unknown>): ToolInvocation[] {
  const response = event.response && typeof event.response === 'object'
    ? (event.response as Record<string, unknown>)
    : null;
  const output = Array.isArray(response?.output) ? response?.output : [];
  const calls: ToolInvocation[] = [];
  for (const entry of output) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== 'function_call') continue;
    const name = normalizeText(record.name);
    const callId = normalizeText(record.call_id) ?? normalizeText(record.id);
    const args = typeof record.arguments === 'string' ? record.arguments : '{}';
    if (!name || !callId) continue;
    calls.push({
      callId,
      name,
      arguments: args,
    });
  }
  return calls;
}

function formatConfidence(value: number): string {
  const pct = Number.isFinite(value) ? value * 100 : 0;
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

const REALTIME_TOOLS = [
  {
    type: 'function',
    name: TOOL_NAMES.PREVIEW,
    description:
      'Preview orchestrator actions from a natural language command. Use this before apply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        input: { type: 'string', description: 'Natural language command from the operator.' },
        workspace_id: { type: 'string', description: 'Optional OrgX workspace/command_center id.' },
      },
      required: ['input'],
    },
  },
  {
    type: 'function',
    name: TOOL_NAMES.APPLY,
    description:
      'Apply selected action ids from a previewed command after user confirmation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command_id: { type: 'string', description: 'Command id from preview response.' },
        confirmed_action_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of action ids to apply. Omit to apply all.',
        },
        workspace_id: { type: 'string', description: 'Optional OrgX workspace/command_center id.' },
      },
      required: ['command_id'],
    },
  },
  {
    type: 'function',
    name: TOOL_NAMES.STATUS,
    description: 'Get latest status for a previously created command.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command_id: { type: 'string', description: 'Command id from preview/apply response.' },
      },
      required: ['command_id'],
    },
  },
] as const;

export function RealtimeOrchestratorModal({
  open,
  selectedWorkspaceId,
  onClose,
}: RealtimeOrchestratorModalProps) {
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [sessionModel, setSessionModel] = useState<string>('gpt-realtime-1.5');
  const [commandInput, setCommandInput] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [command, setCommand] = useState<RealtimeOrchestratorCommand | null>(null);
  const [selectedActionIds, setSelectedActionIds] = useState<string[]>([]);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventLog, setEventLog] = useState<string[]>([]);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const assistantDraftRef = useRef<string>('');
  const handledToolCallIdsRef = useRef<Set<string>>(new Set());

  const logEvent = useCallback((line: string) => {
    setEventLog((previous) => {
      const next = [line, ...previous];
      return next.slice(0, 10);
    });
  }, []);

  const cleanupSession = useCallback(() => {
    setIsListening(false);
    setIsConnected(false);
    handledToolCallIdsRef.current = new Set();

    const channel = dataChannelRef.current;
    if (channel) {
      try {
        channel.close();
      } catch {
        // best effort
      }
    }
    dataChannelRef.current = null;

    const pc = peerConnectionRef.current;
    if (pc) {
      try {
        pc.close();
      } catch {
        // best effort
      }
    }
    peerConnectionRef.current = null;

    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // best effort
        }
      }
    }
    mediaStreamRef.current = null;

    const audio = remoteAudioRef.current;
    if (audio) {
      try {
        const src = audio.srcObject as MediaStream | null;
        src?.getTracks().forEach((track) => track.stop());
      } catch {
        // best effort
      }
      try {
        audio.pause();
      } catch {
        // best effort
      }
      audio.srcObject = null;
    }
    remoteAudioRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) {
      cleanupSession();
      setError(null);
      setAssistantText('');
      setEventLog([]);
      assistantDraftRef.current = '';
    }
  }, [cleanupSession, open]);

  useEffect(() => () => cleanupSession(), [cleanupSession]);

  const sendDataChannelEvent = useCallback((payload: Record<string, unknown>) => {
    const channel = dataChannelRef.current;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(payload));
  }, []);

  const getJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url);
    const json = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      throw new Error((json && typeof json === 'object' && 'error' in json && json.error) || `Request failed: ${response.status}`);
    }
    return json;
  }, []);

  const postJson = useCallback(async <T,>(url: string, body: Record<string, unknown>): Promise<T> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) {
      throw new Error((json && typeof json === 'object' && 'error' in json && json.error) || `Request failed: ${response.status}`);
    }
    return json;
  }, []);

  const executeToolInvocation = useCallback(async (invocation: ToolInvocation) => {
    if (handledToolCallIdsRef.current.has(invocation.callId)) return;
    handledToolCallIdsRef.current.add(invocation.callId);

    try {
      const args = parseJsonObject(invocation.arguments);
      let toolOutput: Record<string, unknown> = { ok: false, error: 'Unsupported tool call.' };

      if (invocation.name === TOOL_NAMES.PREVIEW) {
        const input = normalizeText(args.input);
        if (!input) throw new Error('Preview tool call requires input.');
        const response = await postJson<CommandResponse>('/orgx/api/orchestrator/commands/preview', {
          input,
          workspace_id: normalizeText(args.workspace_id) ?? selectedWorkspaceId ?? undefined,
        });
        if (!response.command) throw new Error(response.error ?? 'Preview command failed.');
        setCommand(response.command);
        setSelectedActionIds(response.command.proposedActions.map((action) => action.actionId));
        toolOutput = { ok: true, command: response.command };
      } else if (invocation.name === TOOL_NAMES.APPLY) {
        const commandId = normalizeText(args.command_id);
        if (!commandId) throw new Error('Apply tool call requires command_id.');
        const actionIds = Array.isArray(args.confirmed_action_ids)
          ? args.confirmed_action_ids.filter((entry): entry is string => typeof entry === 'string')
          : undefined;
        const response = await postJson<CommandResponse>('/orgx/api/orchestrator/commands/apply', {
          command_id: commandId,
          confirmed_action_ids: actionIds,
          workspace_id: normalizeText(args.workspace_id) ?? selectedWorkspaceId ?? undefined,
        });
        if (!response.command) throw new Error(response.error ?? 'Apply command failed.');
        setCommand(response.command);
        toolOutput = { ok: true, command: response.command };
      } else if (invocation.name === TOOL_NAMES.STATUS) {
        const commandId = normalizeText(args.command_id);
        if (!commandId) throw new Error('Status tool call requires command_id.');
        const response = await getJson<CommandResponse>(
          `/orgx/api/orchestrator/commands/${encodeURIComponent(commandId)}`
        );
        if (!response.command) throw new Error(response.error ?? 'Command status unavailable.');
        setCommand(response.command);
        toolOutput = { ok: true, command: response.command };
      }

      sendDataChannelEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: invocation.callId,
          output: JSON.stringify(toolOutput),
        },
      });
      sendDataChannelEvent({ type: 'response.create' });
      logEvent(`Tool executed: ${invocation.name}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tool execution failed.';
      setError(message);
      sendDataChannelEvent({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: invocation.callId,
          output: JSON.stringify({ ok: false, error: message }),
        },
      });
      sendDataChannelEvent({ type: 'response.create' });
      logEvent(`Tool failed: ${invocation.name}`);
    }
  }, [getJson, logEvent, postJson, selectedWorkspaceId, sendDataChannelEvent]);

  const connectRealtime = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone capture is unavailable in this browser/runtime.');
      return;
    }

    setError(null);
    setIsConnecting(true);
    setEventLog([]);
    try {
      const sessionJson = await postJson<SessionResponse>('/orgx/api/realtime/session', {
        workspace_id: selectedWorkspaceId ?? undefined,
        model: 'gpt-realtime-1.5',
        voice: 'alloy',
        tool_choice: 'auto',
        tools: REALTIME_TOOLS,
        instructions:
          'You are the OrgX realtime orchestrator copilot. Use tools for state-changing operations. Before applying actions, state the plan concisely.',
      });

      if (!sessionJson?.session) {
        throw new Error(sessionJson?.error ?? 'Failed to create realtime session.');
      }

      const model =
        normalizeText(sessionJson?.session?.model) ??
        normalizeText(sessionJson?.defaults?.model) ??
        'gpt-realtime-1.5';
      setSessionModel(model);

      const clientSecret = normalizeText(sessionJson?.session?.client_secret?.value);
      if (!clientSecret) {
        throw new Error('Realtime session is missing client_secret.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
      }

      const pc = new RTCPeerConnection();
      peerConnectionRef.current = pc;
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudioRef.current = remoteAudio;
      pc.ontrack = (event) => {
        const [remoteStream] = event.streams;
        if (!remoteStream) return;
        remoteAudio.srcObject = remoteStream;
        void remoteAudio.play().catch(() => {
          // best effort; browser policies may still require user interaction
        });
      };

      const dataChannel = pc.createDataChannel('oai-events');
      dataChannelRef.current = dataChannel;

      dataChannel.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
          const eventType = normalizeText(parsed.type) ?? '';

          if (eventType === 'error') {
            const details = parsed.error && typeof parsed.error === 'object'
              ? (parsed.error as Record<string, unknown>)
              : null;
            const message =
              normalizeText(details?.message) ??
              normalizeText(parsed.message) ??
              'Realtime session error.';
            setError(message);
            logEvent(`Error: ${message}`);
            return;
          }

          if (eventType === 'conversation.item.input_audio_transcription.completed') {
            const userTranscript = extractTranscript(parsed);
            if (userTranscript) setCommandInput(userTranscript);
          }

          if (
            eventType === 'response.output_text.delta' ||
            eventType === 'response.text.delta' ||
            eventType === 'response.output_audio_transcript.delta' ||
            eventType === 'response.audio_transcript.delta'
          ) {
            const delta = normalizeText(parsed.delta) ?? extractTranscript(parsed);
            if (delta) {
              assistantDraftRef.current = `${assistantDraftRef.current}${delta}`;
              setAssistantText(assistantDraftRef.current);
            }
          }

          if (
            eventType === 'response.output_text.done' ||
            eventType === 'response.text.done' ||
            eventType === 'response.output_audio_transcript.done' ||
            eventType === 'response.audio_transcript.done'
          ) {
            const finalText = extractTranscript(parsed);
            if (finalText) {
              assistantDraftRef.current = finalText;
              setAssistantText(finalText);
            }
          }

          if (eventType === 'response.function_call_arguments.done') {
            const callId = normalizeText(parsed.call_id);
            const name = normalizeText(parsed.name);
            if (callId && name) {
              const args = typeof parsed.arguments === 'string' ? parsed.arguments : '{}';
              void executeToolInvocation({ callId, name, arguments: args });
            }
          }

          if (eventType === 'response.output_item.done') {
            const item = parsed.item && typeof parsed.item === 'object'
              ? (parsed.item as Record<string, unknown>)
              : null;
            if (item?.type === 'function_call') {
              const callId = normalizeText(item.call_id) ?? normalizeText(item.id);
              const name = normalizeText(item.name);
              if (callId && name) {
                const args = typeof item.arguments === 'string' ? item.arguments : '{}';
                void executeToolInvocation({ callId, name, arguments: args });
              }
            }
          }

          if (eventType === 'response.done') {
            const calls = extractFunctionCallsFromResponseDone(parsed);
            for (const call of calls) {
              void executeToolInvocation(call);
            }
          }
        } catch {
          // ignore malformed payloads
        }
      };

      dataChannel.onopen = () => {
        setIsConnected(true);
        sendDataChannelEvent({
          type: 'session.update',
          session: {
            tools: REALTIME_TOOLS,
            tool_choice: 'auto',
          },
        });
        logEvent('Realtime connected');
      };
      dataChannel.onclose = () => {
        setIsConnected(false);
        setIsListening(false);
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${clientSecret}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp ?? '',
        }
      );

      if (!sdpResponse.ok) {
        const message = await sdpResponse.text().catch(() => sdpResponse.statusText);
        throw new Error(`Realtime SDP negotiation failed: ${message}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (err) {
      cleanupSession();
      setError(err instanceof Error ? err.message : 'Failed to connect realtime session.');
    } finally {
      setIsConnecting(false);
    }
  }, [cleanupSession, executeToolInvocation, logEvent, postJson, selectedWorkspaceId]);

  const startPushToTalk = useCallback(() => {
    if (!isConnected) return;
    const stream = mediaStreamRef.current;
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = true;
    }
    assistantDraftRef.current = '';
    setAssistantText('');
    setIsListening(true);
    sendDataChannelEvent({ type: 'input_audio_buffer.clear' });
  }, [isConnected, sendDataChannelEvent]);

  const stopPushToTalk = useCallback(() => {
    const stream = mediaStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = false;
      }
    }
    setIsListening(false);
    sendDataChannelEvent({ type: 'input_audio_buffer.commit' });
    sendDataChannelEvent({ type: 'response.create' });
  }, [sendDataChannelEvent]);

  const previewCommand = useCallback(async () => {
    const input = commandInput.trim();
    if (!input) return;
    setIsPreviewing(true);
    setError(null);
    try {
      const response = await postJson<CommandResponse>('/orgx/api/orchestrator/commands/preview', {
        input,
        workspace_id: selectedWorkspaceId ?? undefined,
      });
      if (!response.command) {
        throw new Error(response.error ?? 'Failed to preview command.');
      }
      setCommand(response.command);
      setSelectedActionIds(response.command.proposedActions.map((action) => action.actionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview command.');
    } finally {
      setIsPreviewing(false);
    }
  }, [commandInput, postJson, selectedWorkspaceId]);

  const applyCommand = useCallback(async () => {
    if (!command?.id) return;
    setIsApplying(true);
    setError(null);
    try {
      const response = await postJson<CommandResponse>('/orgx/api/orchestrator/commands/apply', {
        command_id: command.id,
        confirmed_action_ids: selectedActionIds,
        workspace_id: selectedWorkspaceId ?? undefined,
      });
      if (!response.command) {
        throw new Error(response.error ?? 'Failed to apply command.');
      }
      setCommand(response.command);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply command.');
    } finally {
      setIsApplying(false);
    }
  }, [command?.id, postJson, selectedActionIds, selectedWorkspaceId]);

  const selectedActionsCount = selectedActionIds.length;
  const hasPreviewActions = (command?.proposedActions?.length ?? 0) > 0;
  const canApply = Boolean(command?.id) && selectedActionsCount > 0 && !isApplying;

  const commandStatusTone = useMemo(() => {
    const status = command?.status ?? 'draft';
    if (status === 'completed') return 'text-lime';
    if (status === 'completed_with_errors' || status === 'failed') return 'text-amber-300';
    if (status === 'applying') return 'text-teal';
    return 'text-secondary';
  }, [command?.status]);

  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-5xl" fitContent closeOnEscapeWhenTyping={false}>
      <div className="border-b border-strong px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-caption uppercase tracking-[0.14em] text-secondary">Realtime Orchestrator</p>
            <h2 className="text-heading font-semibold text-white">GPT Realtime 1.5</h2>
            <p className="text-micro text-secondary">
              Voice + tool-calls for initiative launch, decision resolution, and Next Up control.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.08] hover:text-white"
          >
            Close
          </button>
        </div>
      </div>

      <div className="grid gap-4 px-4 pb-4 pt-3 lg:grid-cols-[1.12fr_1fr]">
        <section className="space-y-3">
          <div className="rounded-xl border border-strong bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-caption uppercase tracking-[0.12em] text-secondary">Session</span>
              <span className="text-micro text-secondary">{sessionModel}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {!isConnected ? (
                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() => void connectRealtime()}
                  className="rounded-full border border-lime/35 bg-lime/[0.12] px-3 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/[0.2] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isConnecting ? 'Connecting…' : 'Connect Realtime'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onMouseDown={startPushToTalk}
                    onMouseUp={stopPushToTalk}
                    onMouseLeave={() => {
                      if (isListening) stopPushToTalk();
                    }}
                    onTouchStart={(event) => {
                      event.preventDefault();
                      startPushToTalk();
                    }}
                    onTouchEnd={(event) => {
                      event.preventDefault();
                      stopPushToTalk();
                    }}
                    className={`rounded-full border px-3 py-1.5 text-caption font-semibold transition-colors ${
                      isListening
                        ? 'border-teal/45 bg-teal/[0.16] text-teal'
                        : 'border-white/[0.2] bg-white/[0.04] text-primary hover:bg-white/[0.1]'
                    }`}
                  >
                    {isListening ? 'Listening… release to send' : 'Hold to talk'}
                  </button>
                  <button
                    type="button"
                    onClick={cleanupSession}
                    className="rounded-full border border-strong bg-white/[0.03] px-3 py-1.5 text-caption text-secondary transition-colors hover:bg-white/[0.08] hover:text-primary"
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
            {eventLog.length > 0 ? (
              <div className="mt-3 rounded-lg border border-strong bg-black/20 p-2">
                {eventLog.map((line, index) => (
                  <p key={`${line}-${index}`} className="text-micro text-secondary">
                    {line}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="rounded-xl border border-strong bg-white/[0.02] p-3">
            <label className="mb-2 block text-caption uppercase tracking-[0.12em] text-secondary">
              Command Input
            </label>
            <textarea
              value={commandInput}
              onChange={(event) => setCommandInput(event.target.value)}
              rows={4}
              data-modal-autofocus="true"
              placeholder="Example: create initiative called AI Readiness Audit for this workspace"
              className="w-full rounded-lg border border-strong bg-[#040912] px-3 py-2 text-body text-primary placeholder:text-secondary focus:border-lime/35 focus:outline-none"
            />
            {assistantText ? (
              <p className="mt-2 text-caption text-secondary">
                Assistant: <span className="text-primary">{assistantText}</span>
              </p>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={isPreviewing || commandInput.trim().length === 0}
                onClick={() => void previewCommand()}
                className="rounded-full border border-teal/35 bg-teal/[0.12] px-3 py-1.5 text-caption font-semibold text-teal transition-colors hover:bg-teal/[0.2] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPreviewing ? 'Previewing…' : 'Preview Actions'}
              </button>
              <button
                type="button"
                disabled={!canApply}
                onClick={() => void applyCommand()}
                className="rounded-full border border-lime/35 bg-lime/[0.12] px-3 py-1.5 text-caption font-semibold text-lime transition-colors hover:bg-lime/[0.2] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isApplying ? 'Applying…' : `Apply (${selectedActionsCount})`}
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <div className="rounded-xl border border-strong bg-white/[0.02] p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-caption uppercase tracking-[0.12em] text-secondary">Command Status</span>
              <span className={`text-caption font-semibold ${commandStatusTone}`}>
                {command?.status ?? 'idle'}
              </span>
            </div>
            <p className="text-body text-primary">
              {command?.humanSummary ?? 'Preview a command or use voice to trigger tool calls.'}
            </p>
            {command?.riskFlags?.length ? (
              <p className="mt-2 text-caption text-amber-200">Risk flags: {command.riskFlags.join(', ')}</p>
            ) : null}
          </div>

          <div className="max-h-[360px] space-y-2 overflow-y-auto rounded-xl border border-strong bg-white/[0.02] p-3">
            <p className="text-caption uppercase tracking-[0.12em] text-secondary">Proposed Actions</p>
            {!hasPreviewActions ? (
              <p className="text-body text-secondary">No actions inferred yet.</p>
            ) : (
              command!.proposedActions.map((action) => {
                const checked = selectedActionIds.includes(action.actionId);
                return (
                  <label
                    key={action.actionId}
                    className="block rounded-lg border border-strong bg-[#040912] p-2 text-body"
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => {
                          const next = event.target.checked
                            ? [...selectedActionIds, action.actionId]
                            : selectedActionIds.filter((id) => id !== action.actionId);
                          setSelectedActionIds(next);
                        }}
                        className="mt-1"
                      />
                      <div className="min-w-0">
                        <p className="font-semibold text-primary">{action.type}</p>
                        <p className="text-caption text-secondary">{action.reason}</p>
                        <p className="text-micro text-secondary">
                          confidence {formatConfidence(action.confidence)} • impact {action.blockingImpact}
                        </p>
                      </div>
                    </div>
                  </label>
                );
              })
            )}
          </div>

          {(command?.results?.length ?? 0) > 0 ? (
            <div className="max-h-[220px] space-y-2 overflow-y-auto rounded-xl border border-strong bg-white/[0.02] p-3">
              <p className="text-caption uppercase tracking-[0.12em] text-secondary">Apply Results</p>
              {command!.results.map((result) => (
                <div
                  key={`${result.actionId}-${result.type}`}
                  className={`rounded-lg border p-2 text-body ${
                    result.ok
                      ? 'border-lime/30 bg-lime/[0.08] text-lime'
                      : 'border-amber-400/35 bg-amber-500/[0.12] text-amber-100'
                  }`}
                >
                  <p className="font-semibold">{result.type}</p>
                  <p className="text-caption">{result.message}</p>
                  {result.error ? <p className="text-micro text-amber-200">error: {result.error}</p> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      {error ? (
        <div className="border-t border-amber-500/30 bg-amber-500/[0.12] px-4 py-2 text-caption text-amber-100">
          {error}
        </div>
      ) : null}
    </Modal>
  );
}
