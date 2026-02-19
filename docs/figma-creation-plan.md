# Figma OrgX Dashboard Plan

This plan defines a production-grade design-system foundations package for OrgX, grounded in the live plugin UI implementation and exported for Conduit/MCP automation.

## Objectives

- Build a complete `00 Foundations` page that a senior product designer can hand off without ambiguity.
- Keep Figma foundations aligned with runtime values in `dashboard/src/lib/tokens.ts` and `dashboard/src/index.css`.
- Define a predictable mobile foundation set for screens `01` to `05`.
- Export a machine-readable token payload for Conduit-driven generation and updates.

## Veteran-Level Foundations Checklist

1. Brand and intent foundations:
   - Brand promise, tone, anti-patterns, and mood constraints.
   - Accent usage rules (`lime` as primary action, `teal` as secondary/system feedback).
2. Primitive foundations:
   - Explicit scales for spacing, radius, typography, border, blur, elevation, z-index.
   - Semantic color model for text, surfaces, statuses, and states.
3. Layout foundations:
   - Grid, container widths, vertical rhythm, section spacing, safe-area behavior.
   - Desktop and mobile breakpoint rules.
4. Interaction foundations:
   - Hover/press/focus/disabled/loading/error/success behaviors.
   - Motion durations and easing curves with reduced-motion fallback.
5. Accessibility foundations:
   - Focus visibility, minimum tap target (`44px`), contrast expectations, ARIA patterns.
6. Component governance:
   - Naming conventions, slot contracts, variant model, do/don’t examples.
   - “Automatable vs manual review” flags for MCP-based generation.
7. Quality gates:
   - Per-component state completeness.
   - Desktop + mobile proof checks and screenshot evidence.

## Plugin-Derived Foundations (Source of Truth)

Use these source files to keep Figma and code synchronized:

- `dashboard/src/lib/tokens.ts`
- `dashboard/src/index.css`
- `dashboard/tailwind.config.js`
- `dashboard/src/components/shared/ModalShell.tsx`
- `dashboard/src/components/shared/MobileTabBar.tsx`
- `dashboard/src/components/shared/Badge.tsx`

Implementation-derived values:

| Foundation | Current values |
| --- | --- |
| Core accents | `#BFFF00` lime, `#14B8A6` teal, `#0AD4C4` cyan, `#7C7CFF` iris |
| Surfaces | `#02040A` bg, `#08090D` card, `#0C0E14` elevated |
| Text | `#F2F7FF` primary, `#8F9AB7` muted, alpha ramps in CSS vars |
| Type scale | `micro 10/14`, `caption 11/16`, `body 13/20`, `heading 15/22`, `title 20/28` |
| Radius usage | Pill/full, `6`, `8`, `10`, `12`, `14`, `16`, `18`, `24` |
| Spacing usage | Dense use of `6`, `8`, `10`, `12`, `16`, `20`, `24`, `32`, `48` |
| Motion | `100`, `150`, `220`, `360`, `600ms`; cubic-bezier + spring pairs |
| Accessibility | Focus ring, reduced-motion media query, ARIA labels in modal/nav/table flows |

## Required `00 Foundations` Page Structure

Create these sections as separate anchored frames in Figma:

1. `00.1 Brand + Voice`
   - Narrative guardrails, visual anti-patterns, accent hierarchy.
2. `00.2 Color + State Tones`
   - Core palette, text/surface ramps, semantic status tones: `active`, `done`, `blocked`, `planned`.
3. `00.3 Typography`
   - Font families, weights, size/line-height matrix, usage rules by component density.
4. `00.4 Spacing + Layout`
   - 4px base grid, spacing scale, desktop container and mobile inset rules.
5. `00.5 Radius + Border + Elevation`
   - Radius ladder, border hierarchy, shadow tiers, blur values.
6. `00.6 Motion + Interaction`
   - Duration/easing tokens, hover/press/focus/disabled/loading micro-interactions.
7. `00.7 Accessibility + QA`
   - Focus behavior, tap targets, reduced-motion handling, validation checklist.
8. `00.8 Component Governance`
   - Naming convention (`Domain / Component / Variant / State`), slot contracts, variant count limits.
9. `00.9 MCP Coverage Matrix`
   - Mark each foundation as:
     - `Automatable` (direct Conduit command path)
     - `Automatable + Review` (needs visual QA)
     - `Manual` (designer judgment required)

## Mobile Foundations Screens (`01` to `05`)

Deliver five mobile-first foundation screens that reference `00 Foundations`:

1. `01 Mobile Shell`
   - Safe area, status/header zones, tab bar placement, scroll regions.
2. `02 Navigation + Wayfinding`
   - Bottom tab patterns, badges, active/inactive semantics, focus behavior.
3. `03 Cards + Lists`
   - Density presets, hierarchy text styles, avatar/status compositions.
4. `04 Forms + Inputs`
   - Input sizes, validation/error patterns, button hierarchy, disabled/loading states.
5. `05 Feedback + System States`
   - Empty/loading/error/success surfaces, toasts, retry and escalation patterns.

Each screen must include default + stress states (long text, error copy, empty data).

## Automation and Handoff

### Token export

Run:

```bash
npm run export:design-tokens
```

Output:

- `artifacts/orgx-design-tokens.json`

The payload now includes colors, spacing, radius, typography, borders, elevation, blur, breakpoints, z-index, interaction, state tones, and motion.

### Conduit + Figma workflow

1. Start Conduit and verify status:

```bash
npm run verify:conduit-mcp
npm run verify:conduit-mcp -- --require-channel
```

2. Connect the Figma Conduit plugin and capture active channel.
3. Use token names (not raw hex) when generating or mutating nodes.
4. After generation, run visual QA on:
   - token accuracy
   - state completeness
   - mobile behavior (`375px`)
   - accessibility checks (focus/tap target/reduced motion)

## Definition of Done

- `00 Foundations` contains all 9 sections above with explicit token references.
- Mobile screens `01` to `05` exist and link back to foundations primitives.
- Exported token JSON reflects current code tokens.
- Conduit preflight passes with active channel when generation is required.
- Desktop + mobile screenshots captured for review.
