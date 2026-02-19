# Figma OrgX Dashboard Plan

This document lays out how to recreate OrgX's live `dashboard` SPA inside Figma, starting from the design tokens that already power the React version. The goal is to expose a versioned component library that matches spacing, texture, animation, and token usage so that Codex/OrgX agents can drive new flows with minimal guesswork.

## Objectives

- Align every Figma color, spacing, and typography decision with `dashboard/src/lib/tokens.ts` so the exported design system stays in sync with the running product.
- Surface the core panels (Mission Control hierarchy, Activity timeline, pending Decisions, Agent status cards) as reusable components with documented variants.
- Enable designers/agents to accept text commands (via Copilot/MCP) by providing a machine-readable token export plus instructions for proxying commands into Figma (see Conduit below).
- Package the plan so that new copy/illustrations can be dropped in without guessing layout constraints or hover states.

## Reference tokens

Use `dashboard/src/lib/tokens.ts` as the single source of truth. Key values for the Figma library include:

| Name | Value | Role |
| --- | --- | --- |
| `lime` | `#BFFF00` | Primary action/selection accent
| `teal` | `#14B8A6` | Secondary accent for status dots and badges
| `cyan`/`iris` | `#0AD4C4` / `#7C7CFF` | Activity highlights and agent avatars
| `background` | `#02040A` | Page background
| `cardBg` / `cardBgElevated` | `#08090D` / `#0C0E14` | Panel surfaces
| `cardBorder` | `rgba(255, 255, 255, 0.08)` | Soft glass borders
| `text` / `textMuted` | `#F2F7FF` / `#8F9AB7` | Primary/secondary text

Also mirror the agent roles/colors map directly in the Figma palette so that `Pace`, `Eli`, `Dana`, etc., inherit the exact swatches used in the dashboard avatars.

## Component inventory

1. **Mission Control column** – vertical ribbon showing initiatives + workstreams, each with status chips, progress bars, and quick action buttons. Build as modular list items with `expanded`/`collapsed` states.
2. **Activity timeline** – chronological list with avatar, timestamp, action badge (primary/secondary), and descriptive copy. Include a “loading/empty” variant for onboarding.
3. **Decision queue** – card grid for pending approvals. Each card shows the owner, decision summary, status pill (approve/reject) and CTA buttons.
4. **Agent status board** – horizontal collection of cards with avatar, role, availability dot, and AI hints. Provide `online`, `busy`, and `idle` variants aligned to the normalized status tokens.
5. **Command input/control bar** – bottom-aligned prompt area where Codex can drop commands. Use pipe separators, subtle blur, and command chips matching the `cardBorder` highlight.

Document variation for each component: default, hover/focus, disabled, and error states. Capture spacing rules (24px gutters, 12px around chips) and specify typography (Geist family with the app’s system stack) before building.

## Construction steps

1. **Token setup** – import the exported JSON (see tooling below) into a Figma Color Style file named `OrgX Tokens` and sync typography/stroke styles.
2. **Background canvas** – apply `background` swatch, add a `glass` overlay (16% white, blur 32px) behind the main panel. Maintain 32px page padding for desktop and stack components vertically for 375px width.
3. **Build primary panels** – replicate the Mission Control column, Activity timeline, and Agent board using Auto Layout frames that respect the specified spacing tokens. Use consistent border radius (max 12px) and avoid drop shadows beyond the subtle blur.
4. **Command input** – create a reusable component with a prompt icon, placeholder text, and two command chips (e.g., “Plan sprint” + “Refresh live data”). Tag it `Command Input / Default` with a `Command Input / Listening` variant.
5. **Component library sheet** – organize frames into sections with clear naming: `System / Layout`, `System / Tokens`, `Components / Cards`, etc. Add annotations for each variant so that other agents know which component corresponds to which area of the dashboard.

## Automation & handoff

### Token export script

Run `npm run export:design-tokens` (or `node scripts/export-design-tokens.mjs`) to emit a JSON payload that Conduit or any automated tool can feed into Figma’s plugin APIs. The JSON includes color swatches, border radius, typography hints, and agent palette metadata.

### Command proxying via Conduit

1. Clone `https://github.com/eonist/conduit` locally and run its WebSocket server so Codex can send natural-language commands.
2. Open the Conduit Figma plugin inside the OrgX dashboard Figma file, connect to the WebSocket port (e.g., `3055`), then use Codex/MCP commands to call the plugin’s `createNode` helpers.
3. Use the exported tokens to keep color/style commands deterministic—each command should reference the specific token name rather than a hex value.
4. Run `npm run verify:conduit-mcp` before generation runs. For CI or strict preflight, use `npm run verify:conduit-mcp -- --require-channel` to fail unless the Figma plugin has an active channel.

This automation plan lets designers iterate visually while agents plug in the building blocks programmatically.
