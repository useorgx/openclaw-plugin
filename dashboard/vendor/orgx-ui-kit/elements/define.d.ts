import { OxAttentionLine } from './attention-line.js';
import { OxAvatar } from './avatar.js';
import { OxFooter } from './footer.js';
import { OxGlyph } from './glyph.js';
import { OxReceiptRow } from './receipt-row.js';
import { OxStateChip } from './state-chip.js';
export declare const ELEMENTS: {
    readonly 'ox-state-chip': typeof OxStateChip;
    readonly 'ox-attention-line': typeof OxAttentionLine;
    readonly 'ox-receipt-row': typeof OxReceiptRow;
    readonly 'ox-footer': typeof OxFooter;
    readonly 'ox-glyph': typeof OxGlyph;
    readonly 'ox-avatar': typeof OxAvatar;
};
/** Define every element. Idempotent: a second call, or a second copy of the kit, is a no-op. */
export declare function defineElements(): void;
