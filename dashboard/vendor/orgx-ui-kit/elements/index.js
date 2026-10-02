/**
 * @useorgx/orgx-ui-kit/elements
 *
 * Framework-free OrgX elements. Importing this module defines every element
 * once (re-importing, or loading the IIFE too, never throws). Theme them by
 * loading tokens.css; they read nothing but --ox-* and --agent-* variables.
 */
import { OxAttentionLine } from './attention-line.js';
import { OxAvatar } from './avatar.js';
import { OxFooter } from './footer.js';
import { OxGlyph } from './glyph.js';
import { OxReceiptRow } from './receipt-row.js';
import { OxStateChip } from './state-chip.js';
import { ELEMENTS, defineElements } from './define.js';
export { OxAttentionLine, OxAvatar, OxFooter, OxGlyph, OxReceiptRow, OxStateChip };
export { ACTION_STATES, STATE_ALIASES, FOOTER_FRAMES, FOOTER_VARIANTS, resolveState, resolveFooter } from './states.js';
export { GLYPHS, GLYPH_KINDS, glyphSvg } from './glyph.js';
export { RECEIPT_STATUSES, resolveReceiptStatus } from './receipt-row.js';
export { AGENTS, AGENT_KEYS, AVATAR_FORMS, AVATAR_SIZES, avatarConfig, avatarUrl } from './avatar.js';
export { ELEMENTS, defineElements };
defineElements();
