import { type ActionState } from './states.js';
import { OxEl } from './shared.js';
/**
 * <ox-state-chip state="running" detail="step 3 of 5">
 *
 * One pill for every state in the SM0/SM2 action lifecycle. The visible label
 * is the canvas wording ("Not sent", "Partly done", "Waiting in OrgX"), never
 * the raw stored state.
 *
 * Attributes
 *   state    canonical key or alias (see ACTION_STATES / STATE_ALIASES)
 *   label    overrides the visible label
 *   detail   appended after a middle dot: "Running · step 3 of 5"
 *   seconds  for state="held": "Held · undo 8 s"
 *   reserve  "all" or a space-separated list of states whose labels the chip
 *            reserves width for, so a row never reflows as the state moves
 */
export declare class OxStateChip extends OxEl {
    #private;
    static observedAttributes: string[];
    constructor();
    connectedCallback(): void;
    /** The resolved canonical state, or null when the value is unknown. */
    get resolvedState(): ActionState | null;
    protected _render(): void;
}
