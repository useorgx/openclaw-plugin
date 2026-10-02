import { OxEl } from './shared.js';
/**
 * Receipt row statuses, from the K1/K4 receipt cards and the F1 evidence rows:
 * met (teal check), fail (red alert), yours (amber question: "Your call"),
 * unverified (muted hatch), pending (still judging).
 */
export declare const RECEIPT_STATUSES: {
    readonly met: "Met";
    readonly fail: "Fails";
    readonly yours: "Your call";
    readonly unverified: "Unverified";
    readonly pending: "Checking";
};
export type ReceiptStatus = keyof typeof RECEIPT_STATUSES;
export declare function resolveReceiptStatus(raw: string | null): ReceiptStatus;
/**
 * <ox-receipt-row status="fail" label="Retries are bounded on a provider timeout"
 *   detail="Reliability · Judged · unbounded loop" value="0.81 · bar 0.85" href="...">
 *
 * One line of proof. The status is announced ("Fails: ..."), the label wraps
 * to two lines at most, the value sits right in tabular figures. With href the
 * row is a link; a click first dispatches a cancelable `ox-open` event so MCP
 * widgets can route it through openWidgetLink instead of a raw navigation.
 */
export declare class OxReceiptRow extends OxEl {
    static observedAttributes: string[];
    constructor();
    connectedCallback(): void;
    /** The resolved status; setting it sets the attribute (React 19 assigns properties). */
    get status(): ReceiptStatus;
    set status(v: string);
    /** The link target, or null. Only http(s), mailto and relative URLs become links. */
    get safeHref(): string | null;
    protected _render(): void;
}
