/**
 * Public types entrypoint.
 *
 * Kept stable because consumers import `@useorgx/openclaw-plugin/types`.
 * The actual definitions live under `src/contracts/types.ts` so we can
 * share contracts across codebases without tangling with runtime modules.
 */

export * from "./contracts/types.js";
