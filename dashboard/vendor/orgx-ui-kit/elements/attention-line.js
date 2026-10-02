import { ICON, OxEl } from './shared.js';
const CSS = `
:host{display:block;min-width:0}
.l{display:flex;align-items:center;gap:10px;min-height:44px;padding:var(--ox-attention-padding,0 16px);min-width:0}
.m{width:16px;display:grid;place-items:center;flex:none;color:var(--tone)}
.t{font-size:13.5px;line-height:1.3;font-weight:650;color:var(--tone);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:color .6s}
[data-tone=teal] .t{color:var(--ox-text-2);font-weight:500}
.s{flex:1}
::slotted([slot=meta]){font:500 11.5px/1.3 var(--ox-mono);color:var(--ox-text-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
@media (max-width:420px){::slotted([slot=meta]){display:none}.t{white-space:normal}}
`;
/**
 * <ox-attention-line tone="needs-you" count="2" oldest="2d">
 *
 * The one line that opens every OrgX surface: quiet when fine, loud only when
 * it needs you. Amber for "needs you", red when the decision is blocking
 * work, and a calm one-liner when nothing waits (count="0" turns calm too).
 * The line keeps one 44 px row in every tone.
 *
 * Attributes: tone (needs-you | blocking | calm), count, oldest, blocks (tasks
 * held up, for tone="blocking"), label (replaces the generated sentence).
 * Slots: default (custom sentence), "meta" (right-side context, e.g. "Acme ·
 * synced 14:02"; hidden under 420px, where the sentence wraps instead of
 * truncating), "action" (e.g. a refresh button).
 */
export class OxAttentionLine extends OxEl {
    static observedAttributes = ['tone', 'count', 'oldest', 'blocks', 'label'];
    #custom = false;
    constructor() {
        super('<div class="l" part="line"><span class="m" aria-hidden="true"></span><span class="t" part="text"><slot><span></span></slot></span><span class="s"></span><slot name="meta"></slot><slot name="action"></slot></div>', CSS);
        const slot = this._q('slot');
        slot.onslotchange = () => {
            this.#custom = slot.assignedNodes().some((n) => !!n.textContent?.trim());
            this._render();
        };
    }
    connectedCallback() {
        if (!this.hasAttribute('role'))
            this.setAttribute('role', 'status');
        this._render();
    }
    /** needs-you | blocking | calm, after "count=0 is calm". */
    get effectiveTone() {
        const t = this.getAttribute('tone');
        return t == 'calm' || this.getAttribute('count') == '0' ? 'calm' : t == 'blocking' ? 'blocking' : 'needs-you';
    }
    /** The sentence the line reads, also its accessible name. */
    get sentence() {
        const tone = this.effectiveTone;
        const n = Math.max(1, Math.round(+this.getAttribute('count') || 1));
        const b = this.getAttribute('blocks');
        const oldest = this.getAttribute('oldest');
        return (this.getAttribute('label') ||
            (tone == 'calm'
                ? 'Nothing needs your decision.'
                : [
                    `${n} need${n == 1 ? 's' : ''} your decision`,
                    tone == 'blocking' && (b ? `blocking ${b} task${b == '1' ? '' : 's'}` : 'blocking work'),
                    oldest && `oldest ${oldest}`,
                ]
                    .filter(Boolean)
                    .join(' · ')));
    }
    _render() {
        const tone = this.effectiveTone;
        const s = this.sentence;
        this._q('.l').dataset.tone = tone == 'calm' ? 'teal' : tone == 'blocking' ? 'red' : 'amber';
        this.dataset.tone = tone;
        this._q('.m').innerHTML = tone == 'calm' ? ICON.check : ICON.dot;
        this._q('slot span').textContent = s;
        // Slotted custom text is read as-is; otherwise the sentence names the line.
        if (this.#custom)
            this.removeAttribute('aria-label');
        else
            this.setAttribute('aria-label', s);
    }
}
