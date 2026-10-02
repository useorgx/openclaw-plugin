import { OxEl, slug } from './shared.js';
/** The seven agents and their domains. Hues live in tokens (--agent-<key>). */
export const AGENTS = {
    pace: 'Product',
    eli: 'Engineering',
    mark: 'Marketing',
    sage: 'Sales',
    orion: 'Operations',
    dana: 'Design',
    xandy: 'Orchestrator',
};
export const AGENT_KEYS = Object.keys(AGENTS);
/** T6: one signal per form. Base is the resting face. */
export const AVATAR_FORMS = ['base', 'strategic', 'proactive', 'working', 'asking', 'verifying'];
export const AVATAR_SIZES = [48, 96, 192];
/**
 * Where the renders live. Upload `<agent>-<form>-<48|96|192>.webp` (and the
 * `-full.webp` figures) to one folder and point base-url at it, or set
 * avatarConfig.baseUrl once for the page.
 */
export const avatarConfig = { baseUrl: 'https://mcp.useorgx.com/widgets/shared/avatars' };
export const avatarUrl = (baseUrl, agent, form, size) => `${baseUrl.replace(/\/+$/, '')}/${agent}-${form}-${size}.webp`;
const CSS = `
:host{display:inline-block;vertical-align:middle;flex:none;line-height:0}
.a{position:relative;display:block;width:var(--z);height:var(--z);border-radius:50%;padding:var(--g);border:var(--r) solid var(--hue);background:var(--ox-panel-solid);overflow:hidden;transition:border-color .6s}
img,.f{width:100%;height:100%;border-radius:50%;display:block;background:rgba(var(--hue-rgb),.18)}
img{object-fit:cover}
.f{display:none;place-items:center;color:var(--ox-text);font:700 calc(var(--z)*.36)/1 var(--ox-font)}
[data-failed] img{display:none}
[data-failed] .f{display:grid}
`;
/**
 * <ox-avatar agent="eli" form="working" size="48" base-url="https://cdn/avatars">
 *
 * Renders `${baseUrl}/${agent}-${form}-${size}.webp` in a circle with the
 * agent's hue ring (--agent-<key>), with a 2x srcset when a larger render
 * exists. Alt text names the agent and form ("Eli, working"; the base form
 * reads just "Eli"). If the image fails, the agent's initial takes its place
 * in the same footprint, so nothing shifts.
 */
export class OxAvatar extends OxEl {
    static observedAttributes = ['agent', 'form', 'size', 'base-url', 'name'];
    #a;
    #img;
    #f;
    constructor() {
        super('<span class="a" part="avatar"><img decoding="async"><span class="f" role="img"></span></span>', CSS);
        this.#a = this._q('.a');
        this.#img = this._q('img');
        this.#f = this._q('.f');
        this.#img.onerror = () => {
            this.#a.setAttribute('data-failed', '');
            this.dispatchEvent(new Event('ox-avatar-fallback', { bubbles: true, composed: true }));
        };
        this.#img.onload = () => this.#a.removeAttribute('data-failed');
    }
    /** True once the image failed and the initial is showing. */
    get failed() {
        return this.#a.hasAttribute('data-failed');
    }
    /** "Eli, working" (or "Eli" for the base form). */
    get alt() {
        return this.#img.alt;
    }
    _render() {
        const agent = slug(this.getAttribute('agent')) || 'xandy';
        const known = agent in AGENTS;
        const f = slug(this.getAttribute('form'));
        const form = AVATAR_FORMS.includes(f) ? f : 'base';
        const name = this.getAttribute('name') || agent[0].toUpperCase() + agent.slice(1);
        const size = Math.max(16, Math.round(+this.getAttribute('size') || 48));
        const base = this.getAttribute('base-url') ?? avatarConfig.baseUrl;
        // Smallest render at least as large as the display size, plus a 2x source.
        const asset = AVATAR_SIZES.find((s) => s >= size) ?? 192;
        const retina = AVATAR_SIZES.find((s) => s >= size * 2);
        const ring = size < 80 ? 2 : size < 160 ? 3 : 4;
        const hue = known ? `--agent-${agent}` : '--ox-mute';
        // The wrapper reserves the full footprint before the image arrives.
        this.#a.setAttribute('style', `--z:${size}px;--r:${ring}px;--g:${ring < 3 ? 2 : 3}px;--hue:var(${hue});--hue-rgb:var(${hue}-rgb)`);
        this.dataset.agent = agent;
        this.dataset.form = form;
        const alt = form == 'base' ? name : `${name}, ${form}`;
        const src = avatarUrl(base, agent, form, asset);
        const img = this.#img;
        if (img.getAttribute('src') != src) {
            this.#a.removeAttribute('data-failed');
            img.src = src;
        }
        if (retina && retina != asset)
            img.srcset = `${src} 1x, ${avatarUrl(base, agent, form, retina)} 2x`;
        else
            img.removeAttribute('srcset');
        img.width = img.height = size;
        img.alt = alt;
        this.#f.textContent = name[0];
        this.#f.setAttribute('aria-label', alt);
    }
}
