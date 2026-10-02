import { ACTION_STATES, resolveState } from './states.js';
import { ICON, OxEl, esc, ring, slug } from './shared.js';
const CSS = `
:host{display:inline-flex;vertical-align:middle;max-width:100%}
.c{display:inline-flex;align-items:center;gap:6px;height:22px;max-width:100%;padding:0 8px 0 7px;border-radius:999px;font:600 11px/1 var(--ox-mono);white-space:nowrap;color:var(--tone);background:rgba(var(--tone-rgb),.07);border:1px solid rgba(var(--tone-rgb),.3);transition:color .3s,background .3s,border-color .3s}
[data-tone=ink]{background:var(--ox-hover);border-color:var(--ox-border-strong)}
[data-tone=mute]{background:none;border-color:var(--ox-border-strong)}
.i{width:12px;height:12px;display:grid;place-items:center;flex:none}
.i svg{width:12px;height:12px}
.i .spin{width:11px;height:11px;border-width:1.6px;border-top-color:currentColor}
.p .dot{animation:ox-pulse 1s infinite}
@keyframes ox-pulse{50%{opacity:.4}}
.l{display:grid;min-width:0}
.l>span{grid-area:1/1;overflow:hidden;text-overflow:ellipsis}
.g{visibility:hidden}
.n{animation:ox-fade .12s}
`;
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
export class OxStateChip extends OxEl {
    static observedAttributes = ['state', 'label', 'detail', 'seconds', 'reserve'];
    #prev = '';
    constructor() {
        super('<span class="c" part="chip" aria-hidden="true"></span>', CSS);
    }
    connectedCallback() {
        if (!this.hasAttribute('role'))
            this.setAttribute('role', 'status');
        this._render();
    }
    /** The resolved canonical state, or null when the value is unknown. */
    get resolvedState() {
        return resolveState(this.getAttribute('state'));
    }
    #label(key, raw) {
        const s = this.getAttribute('seconds');
        if (key)
            return key == 'held' && s ? `Held · undo ${s} s` : ACTION_STATES[key].label;
        const t = slug(raw).replace(/_/g, ' ') || 'unknown';
        return t[0].toUpperCase() + t.slice(1);
    }
    _render() {
        const raw = this.getAttribute('state');
        const key = resolveState(raw);
        const def = key && ACTION_STATES[key];
        const detail = this.getAttribute('detail');
        const label = this.getAttribute('label') || this.#label(key, raw);
        const text = detail ? `${label} · ${detail}` : label;
        const reserve = (this.getAttribute('reserve') || '').trim();
        const ghosts = (reserve == 'all' ? Object.keys(ACTION_STATES) : reserve ? reserve.split(/\s+/) : [])
            .map((k) => this.#label(resolveState(k), k))
            .filter((g) => g != text);
        const icon = def ? def.icon : 'dot';
        const c = this._q('.c');
        c.dataset.tone = this.dataset.tone = def ? def.tone : 'mute';
        this.dataset.state = key || 'unknown';
        c.innerHTML =
            `<span class="i${icon == 'pulse' ? ' p' : ''}">${icon == 'ring' ? ring(12, 3.4, '36 54') : ICON[icon == 'pulse' ? 'dot' : icon]}</span>` +
                `<span class="l">${ghosts.map((g) => `<span class="g">${esc(g)}</span>`).join('')}<span${this.#prev && this.#prev != text ? ' class="n"' : ''}>${esc(text)}</span></span>`;
        this.#prev = text;
        this.setAttribute('aria-label', text);
    }
}
