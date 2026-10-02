import { OxEl } from './shared.js';
/** The seven agents and their domains. Hues live in tokens (--agent-<key>). */
export declare const AGENTS: {
    readonly pace: "Product";
    readonly eli: "Engineering";
    readonly mark: "Marketing";
    readonly sage: "Sales";
    readonly orion: "Operations";
    readonly dana: "Design";
    readonly xandy: "Orchestrator";
};
export type AgentKey = keyof typeof AGENTS;
export declare const AGENT_KEYS: AgentKey[];
/** T6: one signal per form. Base is the resting face. */
export declare const AVATAR_FORMS: readonly ["base", "strategic", "proactive", "working", "asking", "verifying"];
export type AvatarForm = (typeof AVATAR_FORMS)[number];
export declare const AVATAR_SIZES: readonly [48, 96, 192];
/**
 * Where the renders live. Upload `<agent>-<form>-<48|96|192>.webp` (and the
 * `-full.webp` figures) to one folder and point base-url at it, or set
 * avatarConfig.baseUrl once for the page.
 */
export declare const avatarConfig: {
    baseUrl: string;
};
export declare const avatarUrl: (baseUrl: string, agent: string, form: string, size: number | "full") => string;
/**
 * <ox-avatar agent="eli" form="working" size="48" base-url="https://cdn/avatars">
 *
 * Renders `${baseUrl}/${agent}-${form}-${size}.webp` in a circle with the
 * agent's hue ring (--agent-<key>), with a 2x srcset when a larger render
 * exists. Alt text names the agent and form ("Eli, working"; the base form
 * reads just "Eli"). If the image fails, the agent's initial takes its place
 * in the same footprint, so nothing shifts.
 */
export declare class OxAvatar extends OxEl {
    #private;
    static observedAttributes: string[];
    constructor();
    /** True once the image failed and the initial is showing. */
    get failed(): boolean;
    /** "Eli, working" (or "Eli" for the base form). */
    get alt(): string;
    protected _render(): void;
}
