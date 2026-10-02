import { type FooterVariant } from './states.js';
import { OxEl } from './shared.js';
/**
 * <ox-footer variant="finishes-here" state="needs-you" primary-label="Send" hold>
 *
 * SM3: four footers cover every widget. The same 64 px row in every state:
 * status icon, two lines of text (what happened · what it means), at most one
 * text action and one primary. The action area reserves the width of every
 * label it shows, so the row never reflows as the state moves.
 *
 * Variants and states
 *   finishes-here     needs-you · sending · held · running · done · failed
 *   confirms-in-orgx  needs-you · saving · draft · waiting · confirmed · rejected
 *   queues-work       needs-you · held · queued · running · partial · done
 *   reads             loading · fresh · stale · refreshing · failed · caught-up
 *
 * Attributes: heading, detail ("{s}" = undo seconds left), primary-label,
 * action-label (a trailing ↗ marks a link to OrgX), hold (primary is
 * hold-to-confirm), hold-ms (default 1000), undo-seconds (default 10),
 * undo-deadline (epoch ms; survives reloads), disabled (view only / offline:
 * controls stay, read-only), flush (no top rule).
 * Slots: "primary" and "action" replace the built-in buttons.
 * Events (bubbling, composed): ox-primary, ox-confirm (hold completed),
 * ox-action, ox-undo, ox-undo-expired.
 */
export declare class OxFooter extends OxEl {
    #private;
    static observedAttributes: string[];
    constructor();
    disconnectedCallback(): void;
    attributeChangedCallback(name: string, was: string | null, now: string | null): void;
    /** The resolved state; setting it sets the attribute (React 19 assigns properties). */
    get state(): string;
    set state(v: string);
    /** Whole seconds left in the undo window (0 outside the held state). */
    get undoRemaining(): number;
    protected _render(): void;
}
export type { FooterVariant };
