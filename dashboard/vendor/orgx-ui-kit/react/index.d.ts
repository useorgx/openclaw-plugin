/**
 * @useorgx/orgx-ui-kit/react
 *
 * Thin typed React wrappers over the framework-free elements. Each renders
 * the custom element, maps camelCase props to attributes, wires the element's
 * CustomEvents to on* props, and forwards a ref to the element. Works with
 * React 18 and 19 (React stays a peer dependency).
 */
import { type CSSProperties, type ForwardRefExoticComponent, type ReactNode, type RefAttributes } from 'react';
import '../elements/index.js';
import type { ActionState, AgentKey, AvatarForm, FooterVariant, GlyphKind, OxAttentionLine as OxAttentionLineEl, OxAvatar as OxAvatarEl, OxFooter as OxFooterEl, OxGlyph as OxGlyphEl, OxReceiptRow as OxReceiptRowEl, OxStateChip as OxStateChipEl, ReceiptStatus } from '../elements/index.js';
type AnyString = string & {};
export interface OxBaseProps {
    id?: string;
    className?: string;
    style?: CSSProperties;
    slot?: string;
    /** Overrides the element's generated accessible name. */
    'aria-label'?: string;
    children?: ReactNode;
}
export interface OxStateChipProps extends OxBaseProps {
    state: ActionState | AnyString;
    label?: string;
    detail?: string;
    /** For state="held": seconds left in the undo window. */
    seconds?: number;
    /** "all", or space-separated states whose labels the chip reserves width for. */
    reserve?: 'all' | AnyString;
}
export declare const OxStateChip: ForwardRefExoticComponent<OxStateChipProps & RefAttributes<OxStateChipEl>>;
export interface OxAttentionLineProps extends OxBaseProps {
    tone?: 'needs-you' | 'blocking' | 'calm';
    count?: number;
    oldest?: string;
    blocks?: number;
    label?: string;
    /** Right-side context, e.g. "Acme · synced 14:02" (hidden under 420px). */
    meta?: ReactNode;
    /** Trailing control, e.g. a refresh button. */
    action?: ReactNode;
}
export declare const OxAttentionLine: ForwardRefExoticComponent<OxAttentionLineProps & RefAttributes<OxAttentionLineEl>>;
export interface OxReceiptRowProps extends OxBaseProps {
    status: ReceiptStatus | AnyString;
    label: string;
    value?: string;
    detail?: string;
    href?: string;
    target?: string;
    /** Cancelable. Call e.preventDefault() to route the link yourself (e.g. openWidgetLink). */
    onOpen?: (e: CustomEvent<{
        href: string;
    }>) => void;
}
export declare const OxReceiptRow: ForwardRefExoticComponent<OxReceiptRowProps & RefAttributes<OxReceiptRowEl>>;
export interface OxFooterEventDetail {
    variant: FooterVariant;
    state: string;
    held?: boolean;
    action?: string;
}
export interface OxFooterProps extends OxBaseProps {
    variant: FooterVariant;
    state: string;
    heading?: string;
    /** "{s}" is replaced with the seconds left in the undo window. */
    detail?: string;
    primaryLabel?: string;
    actionLabel?: string;
    /** Primary becomes hold-to-confirm. */
    hold?: boolean;
    holdMs?: number;
    undoSeconds?: number;
    /** Epoch ms when the server commits the held action. */
    undoDeadline?: number;
    disabled?: boolean;
    flush?: boolean;
    /** Replaces the built-in primary button. */
    primary?: ReactNode;
    /** Replaces the built-in text action. */
    action?: ReactNode;
    onPrimary?: (e: CustomEvent<OxFooterEventDetail>) => void;
    onConfirm?: (e: CustomEvent<OxFooterEventDetail>) => void;
    onAction?: (e: CustomEvent<OxFooterEventDetail>) => void;
    onUndo?: (e: CustomEvent<OxFooterEventDetail>) => void;
    onUndoExpired?: (e: CustomEvent<OxFooterEventDetail>) => void;
}
export declare const OxFooter: ForwardRefExoticComponent<OxFooterProps & RefAttributes<OxFooterEl>>;
export interface OxGlyphProps extends OxBaseProps {
    kind: GlyphKind | AnyString;
    tone?: 'muted' | 'amber' | 'teal' | 'red' | 'text' | 'current';
    size?: number;
    /** Set to make the glyph meaningful on its own ("auto" reads the kind). */
    label?: string;
}
export declare const OxGlyph: ForwardRefExoticComponent<OxGlyphProps & RefAttributes<OxGlyphEl>>;
export interface OxAvatarProps extends OxBaseProps {
    agent: AgentKey | AnyString;
    form?: AvatarForm;
    size?: 48 | 96 | 192 | number;
    baseUrl?: string;
    /** Display name for agents outside the seven. */
    name?: string;
    onFallback?: (e: Event) => void;
}
export declare const OxAvatar: ForwardRefExoticComponent<OxAvatarProps & RefAttributes<OxAvatarEl>>;
export type { ActionState, AgentKey, AvatarForm, FooterVariant, GlyphKind, ReceiptStatus };
