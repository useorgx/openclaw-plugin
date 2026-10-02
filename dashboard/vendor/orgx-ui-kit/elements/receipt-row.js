import { glyphSvg } from './glyph.js';
import { ICON, OxEl, emit, esc, slug } from './shared.js';
/**
 * Receipt row statuses, from the K1/K4 receipt cards and the F1 evidence rows:
 * met (teal check), fail (red alert), yours (amber question: "Your call"),
 * unverified (muted hatch), pending (still judging).
 */
export const RECEIPT_STATUSES = {
    met: 'Met',
    fail: 'Fails',
    yours: 'Your call',
    unverified: 'Unverified',
    pending: 'Checking',
};
const ALIASES = { passed: 'met', failed: 'fail', your_call: 'yours', judging: 'pending' };
export function resolveReceiptStatus(raw) {
    const s = slug(raw);
    return s in RECEIPT_STATUSES ? s : (ALIASES[s] ?? 'met');
}
const CSS = `
:host{display:block;min-width:0}
.w{display:contents}
.r{display:grid;grid-template-columns:20px minmax(0,1fr) auto;column-gap:10px;align-items:start;padding:10px 0;min-height:44px;border-top:1px solid var(--ox-border);text-decoration:none}
:host(:first-child) .r,:host([first]) .r{border-top:0}
a.r{grid-template-columns:20px minmax(0,1fr) auto 14px}
a.r:hover .b{text-decoration:underline;text-decoration-color:var(--ox-border-strong);text-underline-offset:3px}
a.r:focus-visible{outline-offset:-2px;border-radius:8px}
.i,.x{height:20px;display:grid;place-items:center}
.i svg{width:15px;height:15px}
.met{color:var(--ox-teal)}.fail{color:var(--ox-danger)}.yours{color:var(--ox-warning)}.unverified,.pending,.x{color:var(--ox-text-muted)}
.h{width:10px;height:10px;border-radius:3px;background:repeating-linear-gradient(135deg,currentColor 0 2px,transparent 2px 4px)}
.i .spin{width:12px;height:12px;border-width:1.6px}
.t{display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:1px}
.b{font-size:13.5px;line-height:1.4;color:var(--ox-text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.d{font-size:12px;line-height:1.35;color:var(--ox-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.v{font:500 11.5px/20px var(--ox-mono);color:var(--ox-text-muted);font-variant-numeric:tabular-nums;max-width:18ch;text-align:right}
@media (max-width:420px){.v{max-width:10ch;line-height:16px;padding-top:2px}}
`;
/**
 * <ox-receipt-row status="fail" label="Retries are bounded on a provider timeout"
 *   detail="Reliability · Judged · unbounded loop" value="0.81 · bar 0.85" href="...">
 *
 * One line of proof. The status is announced ("Fails: ..."), the label wraps
 * to two lines at most, the value sits right in tabular figures. With href the
 * row is a link; a click first dispatches a cancelable `ox-open` event so MCP
 * widgets can route it through openWidgetLink instead of a raw navigation.
 */
export class OxReceiptRow extends OxEl {
    static observedAttributes = ['status', 'label', 'value', 'detail', 'href', 'target'];
    constructor() {
        super('<div class="w"></div>', CSS);
        this._r.addEventListener('click', (e) => {
            const href = this.safeHref;
            if (href && !emit(this, 'ox-open', { href }, true))
                e.preventDefault();
        });
    }
    connectedCallback() {
        if (!this.hasAttribute('role') && this.parentElement?.getAttribute('role') == 'list')
            this.setAttribute('role', 'listitem');
        this._render();
    }
    /** The resolved status; setting it sets the attribute (React 19 assigns properties). */
    get status() {
        return resolveReceiptStatus(this.getAttribute('status'));
    }
    set status(v) {
        this.setAttribute('status', v);
    }
    /** The link target, or null. Only http(s), mailto and relative URLs become links. */
    get safeHref() {
        const h = this.getAttribute('href');
        return h && /^(https?:|mailto:|[/#?.])/i.test(h.trim()) ? h : null;
    }
    _render() {
        const st = this.status;
        const a = (n) => esc(this.getAttribute(n) ?? '');
        const href = this.safeHref;
        const target = this.getAttribute('target') ?? '_blank';
        const value = a('value');
        const detail = a('detail');
        const icon = st == 'met'
            ? ICON.check
            : st == 'fail'
                ? ICON.alert
                : st == 'yours'
                    ? glyphSvg('question', 15)
                    : st == 'unverified'
                        ? '<i class="h"></i>'
                        : ICON.spin;
        const tag = href ? 'a' : 'div';
        const link = href ? ` href="${esc(href)}" target="${esc(target)}"${target == '_blank' ? ' rel="noopener noreferrer"' : ''}` : '';
        this.dataset.status = st;
        this._q('.w').innerHTML =
            `<${tag} class="r" part="row"${link}><span class="i ${st}">${icon}</span>` +
                `<span class="t"><span class="b" part="label"><span class="sr">${RECEIPT_STATUSES[st]}: </span>${a('label')}${value ? `<span class="sr">, ${value}</span>` : ''}</span>` +
                `${detail ? `<span class="d">${detail}</span>` : ''}</span>` +
                `<span class="v" aria-hidden="true">${value}</span>${href ? `<span class="x" aria-hidden="true">${ICON.ext}</span>` : ''}</${tag}>`;
    }
}
