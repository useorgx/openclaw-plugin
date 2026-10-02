import { OxEl } from './shared.js';
/**
 * <ox-attention-line tone="needs-you" count="2" oldest="2d">
 *
 * The one line that opens every OrgX surface: quiet when fine, loud only when
 * it needs you. Amber for "needs you", red when the decision is blocking
 * work, and a calm one-liner when nothing waits (count="0" turns calm too).
 * The line keeps one 44 px row in every tone.
 *
 * Attributes: tone (needs-you | blocking | calm), count, oldest, blocks (tasks
 * held up, for tone="blocking"), label (replaces the generated sentence).
 * Slots: default (custom sentence), "meta" (right-side context, e.g. "Acme ·
 * synced 14:02"; hidden under 420px, where the sentence wraps instead of
 * truncating), "action" (e.g. a refresh button).
 */
export declare class OxAttentionLine extends OxEl {
    #private;
    static observedAttributes: string[];
    constructor();
    connectedCallback(): void;
    /** needs-you | blocking | calm, after "count=0 is calm". */
    get effectiveTone(): 'needs-you' | 'blocking' | 'calm';
    /** The sentence the line reads, also its accessible name. */
    get sentence(): string;
    protected _render(): void;
}
