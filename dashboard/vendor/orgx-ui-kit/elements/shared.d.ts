/**
 * Shared runtime for the framework-free OrgX elements.
 *
 * - No runtime dependencies. Every element styles itself only through the
 *   --ox-* custom properties from tokens.css, so one stylesheet themes light
 *   and dark.
 * - Constructable stylesheets are shared across instances; when the browser
 *   (or jsdom) has no adoptedStyleSheets, a <style> element is used instead.
 * - Safe to import during SSR: nothing touches the DOM until an element is
 *   constructed, and define() is a no-op without customElements.
 * - Written for size: the IIFE must stay under 25 KB minified.
 */
/** HTMLElement in the browser; an inert class elsewhere so SSR imports do not throw. */
export declare const Base: typeof HTMLElement;
/** Attach styles to a shadow root: shared constructable sheets, else a <style>. */
export declare function adoptStyles(root: ShadowRoot, ...css: string[]): void;
/** Open a shadow root, adopt BASE_CSS plus the element's CSS, and stamp its markup. */
export declare function mount(host: HTMLElement, html: string, ...css: string[]): ShadowRoot;
/**
 * Base for every element: a shadow root with BASE_CSS + the element's CSS and
 * markup, rendered on connect and whenever an observed attribute changes.
 */
export declare class OxEl extends Base {
    protected _r: ShadowRoot;
    constructor(html: string, css: string);
    connectedCallback(): void;
    attributeChangedCallback(_name?: string, was?: string | null, now?: string | null): void;
    protected _q<T extends HTMLElement = HTMLElement>(sel: string): T;
    protected _render(): void;
}
/** Define once. Importing the bundle twice, or two copies of it, never throws. */
export declare function define(name: string, ctor: CustomElementConstructor): void;
/** Normalise free-form status strings: "Partly done" -> "partly_done". */
export declare const slug: (v: string | null | undefined) => string;
export declare const emit: <T>(target: HTMLElement, type: string, detail: T, cancelable?: boolean) => boolean;
export declare const esc: (s: string) => string;
/** Tone vocabulary shared by every element. amber = needs you, teal = moving or done. */
export type Tone = 'amber' | 'teal' | 'red' | 'mute' | 'ink';
export declare const ICON: {
    check: string;
    alert: string;
    clock: string;
    lock: string;
    x: string;
    ext: string;
    dot: string;
    spin: string;
};
/** The undo ring (SM3): a 22-unit track with an arc in currentColor. */
export declare const ring: (w: number, sw: number, dash: string) => string;
/** Base CSS adopted by every element: type, focus ring, tones, reduced motion. */
export declare const BASE_CSS = "\n:host{box-sizing:border-box;font-family:var(--ox-font);color:var(--ox-text)}\n:host([hidden]){display:none!important}\n*,*::before,*::after{box-sizing:inherit}\nsvg{display:block;flex:none}\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}\nbutton,a{font:inherit;color:inherit}\n:focus-visible{outline:2px solid var(--ox-focus);outline-offset:2px}\n.dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:block}\n.spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--ox-ring-track);border-top-color:var(--ox-teal);animation:ox-rot .9s linear infinite}\n@keyframes ox-rot{to{transform:rotate(360deg)}}\n@keyframes ox-fade{from{opacity:0}}\n[data-tone=amber]{--tone:var(--ox-warning);--tone-rgb:var(--ox-edge-amber-rgb)}\n[data-tone=teal]{--tone:var(--ox-teal);--tone-rgb:var(--ox-edge-teal-rgb)}\n[data-tone=red]{--tone:var(--ox-danger);--tone-rgb:var(--ox-edge-red-rgb)}\n[data-tone=mute]{--tone:var(--ox-text-muted);--tone-rgb:var(--ox-edge-mute-rgb)}\n[data-tone=ink]{--tone:var(--ox-text-2);--tone-rgb:var(--ox-edge-mute-rgb)}\n@media (prefers-reduced-motion:reduce){\n*:not(.fill),*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition-duration:0s!important}\n.spin{border-right-color:var(--ox-teal)}\n}\n";
