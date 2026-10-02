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
export const Base = typeof HTMLElement != 'undefined' ? HTMLElement : class {
};
const sheets = new Map();
/** Attach styles to a shadow root: shared constructable sheets, else a <style>. */
export function adoptStyles(root, ...css) {
    if (root.adoptedStyleSheets && 'replaceSync' in CSSStyleSheet.prototype) {
        try {
            root.adoptedStyleSheets = css.map((t) => {
                let s = sheets.get(t);
                if (!s)
                    (sheets.set(t, (s = new CSSStyleSheet())), s.replaceSync(t));
                return s;
            });
            return;
        }
        catch {
            /* fall through to <style> */
        }
    }
    const style = document.createElement('style');
    style.textContent = css.join('');
    root.prepend(style);
}
/** Open a shadow root, adopt BASE_CSS plus the element's CSS, and stamp its markup. */
export function mount(host, html, ...css) {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = html;
    adoptStyles(root, BASE_CSS, ...css);
    return root;
}
/**
 * Base for every element: a shadow root with BASE_CSS + the element's CSS and
 * markup, rendered on connect and whenever an observed attribute changes.
 */
export class OxEl extends Base {
    _r;
    constructor(html, css) {
        super();
        this._r = mount(this, html, css);
    }
    connectedCallback() {
        this._render();
    }
    attributeChangedCallback(_name, was, now) {
        if (this.isConnected && was !== now)
            this._render();
    }
    _q(sel) {
        return this._r.querySelector(sel);
    }
    _render() { }
}
/** Define once. Importing the bundle twice, or two copies of it, never throws. */
export function define(name, ctor) {
    if (typeof customElements != 'undefined' && !customElements.get(name))
        customElements.define(name, ctor);
}
/** Normalise free-form status strings: "Partly done" -> "partly_done". */
export const slug = (v) => (v ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
export const emit = (target, type, detail, cancelable = false) => target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true, cancelable }));
export const esc = (s) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/* ---------------------------------------------------------------- icons -- */
/* 16-unit icons from the canvas icon set (stroke = currentColor). */
const svg16 = (w, inner, sw = 1.7) => `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const ICON = {
    check: svg16(14, '<path d="M3 8.5l3.2 3L13 4.5"/>', 1.9),
    alert: svg16(16, '<path d="M8 1.8L15 14H1L8 1.8z"/><path d="M8 6.5v3.2M8 11.8v.1"/>'),
    clock: svg16(14, '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.8V8l2.2 1.6"/>', 1.6),
    lock: svg16(14, '<rect x="3" y="7" width="10" height="7" rx="2"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/>', 1.6),
    x: svg16(12, '<path d="M4 4l8 8M12 4l-8 8"/>', 1.9),
    ext: svg16(14, '<path d="M6 3H3.5A1.5 1.5 0 002 4.5v8A1.5 1.5 0 003.5 14h8a1.5 1.5 0 001.5-1.5V10"/><path d="M9 2h5v5M14 2L7.5 8.5"/>'),
    dot: '<i class="dot"></i>',
    spin: '<i class="spin"></i>',
};
/** The undo ring (SM3): a 22-unit track with an arc in currentColor. */
export const ring = (w, sw, dash) => `<svg class="ring" width="${w}" height="${w}" viewBox="0 0 22 22" aria-hidden="true"><circle cx="11" cy="11" r="8.5" fill="none" stroke="var(--ox-ring-track)" stroke-width="${sw}"/><circle class="arc" cx="11" cy="11" r="8.5" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${dash}" transform="rotate(-90 11 11)"/></svg>`;
/* --------------------------------------------------------------- styles -- */
/** Base CSS adopted by every element: type, focus ring, tones, reduced motion. */
export const BASE_CSS = `
:host{box-sizing:border-box;font-family:var(--ox-font);color:var(--ox-text)}
:host([hidden]){display:none!important}
*,*::before,*::after{box-sizing:inherit}
svg{display:block;flex:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
button,a{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--ox-focus);outline-offset:2px}
.dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:block}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--ox-ring-track);border-top-color:var(--ox-teal);animation:ox-rot .9s linear infinite}
@keyframes ox-rot{to{transform:rotate(360deg)}}
@keyframes ox-fade{from{opacity:0}}
[data-tone=amber]{--tone:var(--ox-warning);--tone-rgb:var(--ox-edge-amber-rgb)}
[data-tone=teal]{--tone:var(--ox-teal);--tone-rgb:var(--ox-edge-teal-rgb)}
[data-tone=red]{--tone:var(--ox-danger);--tone-rgb:var(--ox-edge-red-rgb)}
[data-tone=mute]{--tone:var(--ox-text-muted);--tone-rgb:var(--ox-edge-mute-rgb)}
[data-tone=ink]{--tone:var(--ox-text-2);--tone-rgb:var(--ox-edge-mute-rgb)}
@media (prefers-reduced-motion:reduce){
*:not(.fill),*::before,*::after{animation-duration:0s!important;animation-iteration-count:1!important;transition-duration:0s!important}
.spin{border-right-color:var(--ox-teal)}
}
`;
