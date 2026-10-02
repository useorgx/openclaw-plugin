import { OxEl } from './shared.js';
/*
 * G1 "One shape per kind of work": 24-point grid, 1.8 stroke, round caps.
 * A tinted field says what kind of thing it is; one solid mark is the unit.
 * Muted by default, amber when it needs you, teal when accepted.
 * Inner SVG copied from the canvas glyph set (LiveWidgetIcons grammar);
 * `~` stands for the tinted-field fill and `@` for a solid mark, expanded below.
 */
const SRC = {
    goal: '<circle cx="12" cy="12" r="9.5" ~/><path d="M4.6 18.2 6.9 14.6h10.3l1.9 3.6z" fill="currentColor" fill-opacity=".55" stroke="none"/><path d="M3.8 18.2 10 8.6l2.5 3.5 2.3-2.9 5.4 9"/><path d="M3.8 18.2h16.4"/>',
    initiative: '<circle cx="12" cy="12" r="9" ~/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" @/>',
    workstream: '<rect x="2" y="2" width="20" height="20" rx="6" ~/><path d="M6 6c3 0 5 6 8 6"/><path d="M6 18c3 0 5-6 8-6"/><path d="M6 12h12"/><path d="m14 8 4 4-4 4"/><circle cx="6" cy="6" r="1.5" @/><circle cx="6" cy="12" r="1.5" @/><circle cx="6" cy="18" r="1.5" @/>',
    milestone: '<path d="M5 3v18"/><path d="m5 4 12 1-2 4 2 4-12-1z" fill="currentColor" fill-opacity=".1"/>',
    task: '<rect x="4" y="4" width="16" height="16" rx="4" fill="currentColor" fill-opacity=".12" stroke="none"/><path d="M9 12.2 11 14.2 15.2 10"/>',
    run: '<circle cx="12" cy="12" r="9" ~/><path d="M10 8.5v7l5.5-3.5z" fill="currentColor"/>',
    decision: '<path d="M12 2.8 21.2 12 12 21.2 2.8 12z" ~/><path d="M12 17.5v-5"/><path d="M12 12.5 8.5 8.2"/><path d="M12 12.5l3.5-4.3"/><circle cx="8.5" cy="8.2" r="1.4" @/><circle cx="15.5" cy="8.2" r="1.4" @/>',
    question: '<path d="M4 6.5A3.5 3.5 0 0 1 7.5 3h9A3.5 3.5 0 0 1 20 6.5v6a3.5 3.5 0 0 1-3.5 3.5H11l-4.5 4v-4A3.5 3.5 0 0 1 4 12.5z" ~/><path d="M9.6 8.2a2.5 2.5 0 0 1 4.8.8c0 1.6-2.4 1.9-2.4 3.2"/><circle cx="12" cy="14.6" r="1.1" @/>',
    artifact: '<path d="M6 3h8l4 4v14H6z" ~/><path d="M14 3v4h4"/><path d="M6 3h8l4 4v14H6z"/><path d="M9 12h6M9 15.5h4"/>',
    receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z" ~/><path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4z"/><path d="M9 10.6 11 12.6 15 8.6"/><path d="M9 16h6"/>',
};
export const GLYPH_KINDS = Object.keys(SRC);
/** Inner SVG markup per kind (24 x 24 viewBox). */
export const GLYPHS = Object.fromEntries(GLYPH_KINDS.map((k) => [
    k,
    SRC[k].replace(/~/g, 'fill="currentColor" fill-opacity=".1" stroke="none"').replace(/@/g, 'fill="currentColor" stroke="none"'),
]));
export const glyphSvg = (kind, size = 18) => `<svg width="${size}" height="${size}" style="width:var(--ox-glyph-size,${size}px);height:var(--ox-glyph-size,${size}px)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[kind] ?? GLYPHS.task}</svg>`;
const CSS = `
:host{display:inline-grid;place-items:center;vertical-align:middle;flex:none;color:var(--ox-text-muted);line-height:0}
:host([tone=amber]){color:var(--ox-warning)}
:host([tone=teal]){color:var(--ox-teal)}
:host([tone=red]){color:var(--ox-danger)}
:host([tone=text]){color:var(--ox-text-2)}
:host([tone=current]){color:inherit}
span{display:contents}
`;
/**
 * <ox-glyph kind="decision" tone="amber" size="18" label="Decision">
 *
 * kind: goal | initiative | workstream | milestone | task | run | decision |
 * question | artifact | receipt. tone: muted (default) | amber |
 * teal | red | text | current. Decorative unless `label` is set
 * (label="auto" reads the kind name). --ox-glyph-size sizes every glyph in a
 * container at once.
 */
export class OxGlyph extends OxEl {
    static observedAttributes = ['kind', 'size', 'label'];
    constructor() {
        super('<span></span>', CSS);
    }
    _render() {
        const raw = (this.getAttribute('kind') ?? '').toLowerCase();
        const kind = raw in SRC ? raw : 'task';
        this._q('span').innerHTML = glyphSvg(kind, +this.getAttribute('size') || 18);
        this.dataset.kind = kind;
        const label = this.getAttribute('label')?.trim();
        if (label) {
            this.setAttribute('role', 'img');
            this.setAttribute('aria-label', label == 'auto' ? kind[0].toUpperCase() + kind.slice(1) : label);
            this.removeAttribute('aria-hidden');
        }
        else {
            this.removeAttribute('role');
            this.removeAttribute('aria-label');
            this.setAttribute('aria-hidden', 'true');
        }
    }
}
