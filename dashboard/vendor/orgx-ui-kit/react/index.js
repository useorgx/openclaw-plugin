'use client';
/**
 * @useorgx/orgx-ui-kit/react
 *
 * Thin typed React wrappers over the framework-free elements. Each renders
 * the custom element, maps camelCase props to attributes, wires the element's
 * CustomEvents to on* props, and forwards a ref to the element. Works with
 * React 18 and 19 (React stays a peer dependency).
 */
import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, } from 'react';
import '../elements/index.js';
function toAttr(v) {
    if (v === undefined || v === null || v === false)
        return undefined;
    if (v === true)
        return '';
    return String(v);
}
function wrap(tag, displayName, spec) {
    const C = forwardRef(function OxWrapper(rawProps, ref) {
        const props = rawProps;
        const node = useRef(null);
        const latest = useRef(props);
        latest.current = props;
        useImperativeHandle(ref, () => node.current, []);
        // One listener per event for the element's lifetime; it calls the latest handler.
        useEffect(() => {
            const target = node.current;
            if (!target || !spec.events)
                return;
            const offs = [];
            for (const [prop, type] of Object.entries(spec.events)) {
                const fn = (e) => {
                    const h = latest.current[prop];
                    if (typeof h === 'function')
                        h(e);
                };
                target.addEventListener(type, fn);
                offs.push(() => target.removeEventListener(type, fn));
            }
            return () => offs.forEach((off) => off());
        }, []);
        // DOM properties (objects) are assigned, not stringified.
        useEffect(() => {
            const target = node.current;
            if (!target || !spec.props)
                return;
            for (const p of spec.props) {
                const v = props[p];
                if (v !== undefined)
                    target[p] = v;
            }
        });
        const domProps = { ref: node };
        if (props.id)
            domProps.id = props.id;
        if (props.className)
            domProps.className = props.className;
        if (props.style)
            domProps.style = props.style;
        if (props.slot)
            domProps.slot = props.slot;
        if (props['aria-label'])
            domProps['aria-label'] = props['aria-label'];
        for (const [prop, attr] of Object.entries(spec.attrs)) {
            const v = toAttr(props[prop]);
            if (v !== undefined)
                domProps[attr] = v;
        }
        const kids = [];
        if (spec.slots) {
            for (const [prop, slot] of Object.entries(spec.slots)) {
                const content = props[prop];
                if (content !== undefined && content !== null && content !== false) {
                    kids.push(createElement('span', { key: `slot-${slot}`, slot }, content));
                }
            }
        }
        if (props.children !== undefined)
            kids.unshift(props.children);
        return createElement(tag, domProps, ...kids);
    });
    C.displayName = displayName;
    return C;
}
export const OxStateChip = wrap('ox-state-chip', 'OxStateChip', {
    attrs: { state: 'state', label: 'label', detail: 'detail', seconds: 'seconds', reserve: 'reserve' },
});
export const OxAttentionLine = wrap('ox-attention-line', 'OxAttentionLine', {
    attrs: { tone: 'tone', count: 'count', oldest: 'oldest', blocks: 'blocks', label: 'label' },
    slots: { meta: 'meta', action: 'action' },
});
export const OxReceiptRow = wrap('ox-receipt-row', 'OxReceiptRow', {
    attrs: { status: 'status', label: 'label', value: 'value', detail: 'detail', href: 'href', target: 'target' },
    events: { onOpen: 'ox-open' },
});
export const OxFooter = wrap('ox-footer', 'OxFooter', {
    attrs: {
        variant: 'variant',
        state: 'state',
        heading: 'heading',
        detail: 'detail',
        primaryLabel: 'primary-label',
        actionLabel: 'action-label',
        hold: 'hold',
        holdMs: 'hold-ms',
        undoSeconds: 'undo-seconds',
        undoDeadline: 'undo-deadline',
        disabled: 'disabled',
        flush: 'flush',
    },
    events: {
        onPrimary: 'ox-primary',
        onConfirm: 'ox-confirm',
        onAction: 'ox-action',
        onUndo: 'ox-undo',
        onUndoExpired: 'ox-undo-expired',
    },
    slots: { primary: 'primary', action: 'action' },
});
export const OxGlyph = wrap('ox-glyph', 'OxGlyph', {
    attrs: { kind: 'kind', tone: 'tone', size: 'size', label: 'label' },
});
export const OxAvatar = wrap('ox-avatar', 'OxAvatar', {
    attrs: { agent: 'agent', form: 'form', size: 'size', baseUrl: 'base-url', name: 'name' },
    events: { onFallback: 'ox-avatar-fallback' },
});
