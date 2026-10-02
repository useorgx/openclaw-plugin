import { type Tone } from './shared.js';
/**
 * The canonical action lifecycle, from the canvas boards:
 *   SM0 "One lifecycle for every action" (nodes: label, stored state, tone)
 *   SM2 "Every component, every state" (columns: superseded, offline, view only)
 *   SM3 "Reads and refreshes" (stale)
 *   T4 agent presence (blocked, delivered)
 *
 * `label` is the word the person reads (SM0 node title); the comment beside
 * each row is the server-side state SM0 prints under it. Tones follow the SM0
 * legend: amber needs you, teal moving or done, red failed (retryable), mute
 * out of your hands, ink in flight.
 */
export type StateIcon = 'dot' | 'spin' | 'ring' | 'check' | 'alert' | 'clock' | 'lock' | 'x' | 'pulse';
export interface StateDef {
    label: string;
    tone: Tone;
    icon: StateIcon;
}
declare const TABLE: {
    readonly needs_you: readonly ["Needs you", "amber", "dot"];
    readonly sending: readonly ["Sending", "ink", "spin"];
    readonly held: readonly ["Held · undo", "amber", "ring"];
    readonly committed: readonly ["Committed", "teal", "dot"];
    readonly queued: readonly ["Queued", "teal", "clock"];
    readonly running: readonly ["Running", "teal", "spin"];
    readonly verifying: readonly ["Verifying", "teal", "pulse"];
    readonly succeeded: readonly ["Done", "teal", "check"];
    readonly undone: readonly ["Undone", "mute", "x"];
    readonly cancelled: readonly ["Cancelled", "mute", "x"];
    readonly paused_for_input: readonly ["Needs you again", "amber", "dot"];
    readonly failed: readonly ["Not sent", "red", "alert"];
    readonly retrying: readonly ["Retrying", "amber", "spin"];
    readonly failed_step: readonly ["Run failed", "red", "alert"];
    readonly partially_succeeded: readonly ["Partly done", "amber", "alert"];
    readonly draft: readonly ["Draft saved", "amber", "lock"];
    readonly handed_off: readonly ["Waiting in OrgX", "mute", "clock"];
    readonly confirmed: readonly ["Confirmed in OrgX", "teal", "check"];
    readonly rejected: readonly ["Rejected in OrgX", "mute", "x"];
    readonly expired: readonly ["Lapsed", "mute", "clock"];
    readonly superseded: readonly ["Superseded", "mute", "dot"];
    readonly stale: readonly ["Stale", "amber", "clock"];
    readonly offline: readonly ["Offline", "mute", "dot"];
    readonly view_only: readonly ["View only", "mute", "lock"];
    readonly blocked: readonly ["Blocked", "red", "alert"];
    readonly delivered: readonly ["Delivered", "teal", "check"];
};
export type ActionState = keyof typeof TABLE;
export declare const ACTION_STATES: Record<ActionState, StateDef>;
/** Accepted spellings from tool output and other surfaces ("alias:canonical"). */
export declare const STATE_ALIASES: Record<string, ActionState>;
export declare function resolveState(raw: string | null | undefined): ActionState | null;
/**
 * SM3: "Four footers cover all 16 widgets. Same 64 px row, same slots, in
 * every state." Each frame: tone, status icon, two lines (what happened ·
 * what it means), and at most one text action or one primary.
 */
export type FooterVariant = 'finishes-here' | 'confirms-in-orgx' | 'queues-work' | 'reads';
export type FooterIcon = 'seal' | 'app' | 'spin' | 'ring' | 'check' | 'alert' | 'clock' | 'lock' | 'x' | 'skel' | 'part';
export interface FooterFrame {
    tone: Exclude<Tone, 'ink'>;
    icon: FooterIcon;
    heading: string;
    detail: string;
    /** Primary button label (amber fill). */
    primary?: string;
    /** Text action label. */
    action?: string;
    /** Primary shows a busy sweep and is not actionable. */
    busy?: boolean;
    /** Label opens OrgX (rendered with the external arrow). */
    ext?: boolean;
    /** Caption used in galleries (SM3 frame label). */
    name: string;
}
export declare const FOOTER_FRAMES: Record<FooterVariant, Record<string, FooterFrame>>;
export declare const FOOTER_VARIANTS: FooterVariant[];
export declare function resolveFooter(variantRaw: string | null, stateRaw: string | null): {
    variant: FooterVariant;
    state: string;
    frame: FooterFrame;
};
export {};
