import { OxAttentionLine } from './attention-line.js';
import { OxAvatar } from './avatar.js';
import { OxFooter } from './footer.js';
import { OxGlyph } from './glyph.js';
import { OxReceiptRow } from './receipt-row.js';
import { OxStateChip } from './state-chip.js';
import { define } from './shared.js';
export const ELEMENTS = {
    'ox-state-chip': OxStateChip,
    'ox-attention-line': OxAttentionLine,
    'ox-receipt-row': OxReceiptRow,
    'ox-footer': OxFooter,
    'ox-glyph': OxGlyph,
    'ox-avatar': OxAvatar,
};
/** Define every element. Idempotent: a second call, or a second copy of the kit, is a no-op. */
export function defineElements() {
    for (const [name, ctor] of Object.entries(ELEMENTS))
        define(name, ctor);
}
