import { slug } from './shared.js';
const def = (r) => ({ label: r[0], tone: r[1], icon: r[2] });
const TABLE = {
    needs_you: ['Needs you', 'amber', 'dot'], // open
    sending: ['Sending', 'ink', 'spin'], // received
    held: ['Held · undo', 'amber', 'ring'], // held (10 s server hold)
    committed: ['Committed', 'teal', 'dot'], // committed
    queued: ['Queued', 'teal', 'clock'], // run queued
    running: ['Running', 'teal', 'spin'], // step n of N
    verifying: ['Verifying', 'teal', 'pulse'], // checks
    succeeded: ['Done', 'teal', 'check'], // succeeded (Done · receipt)
    undone: ['Undone', 'mute', 'x'], // cancelled during the hold
    cancelled: ['Cancelled', 'mute', 'x'], // cancelled
    paused_for_input: ['Needs you again', 'amber', 'dot'], // paused_for_input
    failed: ['Not sent', 'red', 'alert'], // failed · retryable
    retrying: ['Retrying', 'amber', 'spin'], // attempt 2 of 3
    failed_step: ['Run failed', 'red', 'alert'], // failed_step
    partially_succeeded: ['Partly done', 'amber', 'alert'], // 2 of 3
    draft: ['Draft saved', 'amber', 'lock'], // draft · not applied
    handed_off: ['Waiting in OrgX', 'mute', 'clock'], // handed_off
    confirmed: ['Confirmed in OrgX', 'teal', 'check'], // confirmed
    rejected: ['Rejected in OrgX', 'mute', 'x'], // rejected
    expired: ['Lapsed', 'mute', 'clock'], // expired · default
    superseded: ['Superseded', 'mute', 'dot'], // SM2: someone else ruled first
    stale: ['Stale', 'amber', 'clock'], // SM3 reads: as of 13:44
    offline: ['Offline', 'mute', 'dot'], // SM2
    view_only: ['View only', 'mute', 'lock'], // SM2
    blocked: ['Blocked', 'red', 'alert'], // T4 presence: missing access
    delivered: ['Delivered', 'teal', 'check'], // T4 presence: handed over
};
export const ACTION_STATES = Object.fromEntries(Object.entries(TABLE).map(([k, r]) => [k, def(r)]));
/** Accepted spellings from tool output and other surfaces ("alias:canonical"). */
export const STATE_ALIASES = Object.fromEntries(('idle:needs_you open:needs_you pending:sending received:sending done:succeeded completed:succeeded ' +
    'canceled:cancelled error:failed run_failed:failed_step ' +
    'partial:partially_succeeded partly_done:partially_succeeded waiting:handed_off lapsed:expired conflict:superseded')
    .split(' ')
    .map((p) => p.split(':')));
export function resolveState(raw) {
    const s = slug(raw);
    if (s in TABLE)
        return s;
    return STATE_ALIASES[s] ?? null;
}
/*
 * One frame per line: state | tone | icon | heading | detail | button | caption.
 * Button: "P:label" primary, "A:label" text action, "B:label" busy primary;
 * a trailing ↗ means it opens OrgX. Copy is the SM3 canvas wording, made
 * generic where the canvas used example data.
 */
const FRAMES_SRC = {
    'finishes-here': `needs-you|amber|seal|Finishes here|undo 10 s|P:Send|Needs you
sending|amber|spin|Sending|your answers|B:Sending…|Sending
held|amber|ring|Saved|undo {s} s|A:Undo|Held · undo
running|teal|spin|Running|step 1 of 3|A:Watch ↗|Running
done|teal|check|Done|checks passed|A:Receipt ↗|Done
failed|red|alert|Not sent|answers kept|P:Retry|Failed`,
    'confirms-in-orgx': `needs-you|amber|app|Confirms in OrgX|production|P:Save draft|Needs you
saving|amber|spin|Saving draft|nothing applied|B:Saving…|Saving
draft|amber|lock|Draft saved|not applied yet|P:Confirm in OrgX ↗|Draft
waiting|mute|clock|Opened in OrgX|waiting for you there|A:Check now|Waiting
confirmed|teal|check|Confirmed by you|applied|A:Receipt ↗|Confirmed
rejected|mute|x|Rejected by you|the agent reworks it|A:Receipt ↗|Rejected`,
    'queues-work': `needs-you|amber|seal|Ready to queue|undo 10 s|P:Queue|Needs you
held|amber|ring|Queued|undo {s} s|A:Undo|Held · undo
queued|teal|clock|Waiting to start|about 1 min|A:Cancel|Queued
running|teal|spin|Running|1 of 3 done|A:Watch ↗|Running
partial|amber|part|Partly done|1 over the cap|P:Confirm in OrgX ↗|Partly done
done|teal|check|Done|within budget|A:Receipt ↗|Done`,
    reads: `loading|mute|skel|||-|Loading
fresh|teal|check|Synced just now|up to date|A:Open ↗|Fresh
stale|amber|clock|Out of date|a newer version may exist|A:Refresh|Stale
refreshing|mute|spin|Refreshing|keeps what you see|-|Refreshing
failed|red|alert|Couldn’t refresh|showing the last copy|A:Retry|Failed
caught-up|teal|check|Nothing waits on you|all caught up|-|Caught up`,
};
function parseFrames(src) {
    const out = {};
    for (const line of src.split('\n')) {
        const [state, tone, icon, heading, detail, btn, name] = line.split('|');
        const f = { tone: tone, icon: icon, heading: heading, detail: detail, name: name };
        if (btn && btn !== '-') {
            const kind = btn[0];
            let label = btn.slice(2);
            if (label.endsWith(' ↗')) {
                f.ext = true;
                label = label.slice(0, -2);
            }
            if (kind === 'A')
                f.action = label;
            else
                f.primary = label;
            if (kind === 'B')
                f.busy = true;
        }
        out[state] = f;
    }
    return out;
}
export const FOOTER_FRAMES = Object.fromEntries(Object.entries(FRAMES_SRC).map(([v, src]) => [v, parseFrames(src)]));
export const FOOTER_VARIANTS = Object.keys(FRAMES_SRC);
const FOOTER_ALIASES = {
    idle: 'needs-you',
    open: 'needs-you',
    pending: 'sending',
    undo: 'held',
    succeeded: 'done',
    partially_succeeded: 'partial',
    partly_done: 'partial',
};
export function resolveFooter(variantRaw, stateRaw) {
    const v = slug(variantRaw).replace(/_/g, '-');
    const variant = v in FOOTER_FRAMES ? v : 'finishes-here';
    const frames = FOOTER_FRAMES[variant];
    const s = slug(stateRaw);
    let state = s.replace(/_/g, '-');
    if (!(state in frames))
        state = FOOTER_ALIASES[s] ?? '';
    if (!(state in frames))
        state = Object.keys(frames)[0];
    return { variant, state, frame: frames[state] };
}
