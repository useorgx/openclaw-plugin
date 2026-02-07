/**
 * OrgX OpenClaw Plugin — Backward Compatibility Entry
 *
 * Re-export from the canonical src/index.ts entry point so OpenClaw can
 * load this plugin from a source directory path.
 */

export * from "./src/index.js";
export { default } from "./src/index.js";
