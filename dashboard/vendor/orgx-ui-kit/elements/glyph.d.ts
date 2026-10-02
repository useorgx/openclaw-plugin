import { OxEl } from './shared.js';
declare const SRC: {
    goal: string;
    initiative: string;
    workstream: string;
    milestone: string;
    task: string;
    run: string;
    decision: string;
    question: string;
    artifact: string;
    receipt: string;
};
export type GlyphKind = keyof typeof SRC;
export declare const GLYPH_KINDS: GlyphKind[];
/** Inner SVG markup per kind (24 x 24 viewBox). */
export declare const GLYPHS: Record<GlyphKind, string>;
export declare const glyphSvg: (kind: string, size?: number) => string;
/**
 * <ox-glyph kind="decision" tone="amber" size="18" label="Decision">
 *
 * kind: goal | initiative | workstream | milestone | task | run | decision |
 * question | artifact | receipt. tone: muted (default) | amber |
 * teal | red | text | current. Decorative unless `label` is set
 * (label="auto" reads the kind name). --ox-glyph-size sizes every glyph in a
 * container at once.
 */
export declare class OxGlyph extends OxEl {
    static observedAttributes: string[];
    constructor();
    protected _render(): void;
}
export {};
