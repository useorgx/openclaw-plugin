# Task: Build OrgX Live Dashboard React SPA

You are building a React SPA dashboard for the OrgX Clawdbot plugin. This dashboard will be served at `/orgx/live` on the Clawdbot gateway.

## What to build

A complete React SPA that combines:
1. The feature set from `../_reference/orgx-live-dashboard.html` (93KB standalone HTML dashboard)
2. The design quality/smoothness from `../_reference/live-page-reference.tsx` (the OrgX /live React page)

## Tech Stack
- React 18 + TypeScript
- Vite (bundler)
- Framer Motion (animations — match the /live page's motion design)
- Tailwind CSS v3 (styling)
- No external UI libraries — custom components only

## Design Tokens (from /live page)
```
lime: #c8e64a
teal: #7dd3c0
background: #080808
cardBg: #0f0f0f
cardBorder: rgba(255, 255, 255, 0.06)
font: -apple-system, BlinkMacSystemFont, system-ui, 'SF Pro Text', 'Inter', sans-serif
```

## Components to Build (in dashboard/src/components/)

### layout/
- `CompactHeader.tsx` — Sticky header with connection status indicator (pulsing dot), share button, stop button
- `ThreeColumnLayout.tsx` — Desktop: agents(left) | activity(center) | initiatives(right). Mobile: tabs
- `MobileNav.tsx` — Bottom tab bar for mobile (Activity, Agents, Initiatives, Decisions)

### agents/
- `AgentPanel.tsx` — Left column. Groups agents by status (working, waiting, idle). Click to filter activity.
- `AgentRow.tsx` — Agent avatar + name + role + task + progress bar
- `AgentAvatar.tsx` — Colored circle with initials, status dot overlay
- `StatusIndicator.tsx` — Pulsing dot for working/planning, static for idle/blocked

### activity/
- `ActivityStream.tsx` — Center column. Filterable activity feed with tabs (all/artifacts/decisions). Search. Pagination.
- `ActivityItem.tsx` — Agent avatar + action description + timestamp + optional artifact button
- `ArtifactPreview.tsx` — Modal with artifact content (PR diffs, email drafts, documents)

### initiatives/
- `InitiativePanel.tsx` — Right column. List of initiatives with search and pagination.
- `InitiativeCard.tsx` — Category badge + name + avatar stack + phase progress bar
- `PhaseProgress.tsx` — Multi-step progress with completed/current/upcoming indicators

### decisions/
- `DecisionBanner.tsx` — Top banner for pending decisions with review button
- `DecisionModal.tsx` — Modal with decision context, options, approve/reject actions

### onboarding/
- `OnboardingWizard.tsx` — First-run setup wizard (3 steps)
- `ApiKeyStep.tsx` — Enter or auto-detect OrgX API key
- `ConnectionTest.tsx` — Test connection, show org name + stats
- `WelcomeDashboard.tsx` — Quick feature tour overlay

### shared/
- `PremiumCard.tsx` — Glass card with gradient overlay + shadow (from /live page)
- `SearchInput.tsx` — Search with icon
- `Badge.tsx` — Pill badge
- `Modal.tsx` — Animated modal with backdrop blur (Framer Motion)

## Hooks (in dashboard/src/hooks/)
- `useLiveData.ts` — Polls `/orgx/api/status` every 5s, returns agents/activities/initiatives/decisions
- `useConnection.ts` — Tracks connection state (connected/reconnecting/disconnected)
- `useOnboarding.ts` — Manages first-run state (localStorage)

## Key Animation Patterns (from /live page — USE THESE)
```tsx
// Modal enter/exit
<motion.div
  initial={{ opacity: 0, scale: 0.95, y: 20 }}
  animate={{ opacity: 1, scale: 1, y: 0 }}
  exit={{ opacity: 0, scale: 0.95, y: 20 }}
  transition={{ duration: 0.2 }}
/>

// Status indicator pulse
<span className="absolute inset-0 rounded-full animate-ping opacity-40" />

// Spring easing for interactive elements
transition={{ type: "spring", stiffness: 300, damping: 20 }}
```

## Data Flow
The dashboard SPA fetches from relative URLs that the plugin's HTTP handler will proxy:
- `GET /orgx/api/status` → OrgX org snapshot
- `GET /orgx/api/agents` → Agent states
- `GET /orgx/api/activity` → Activity feed
- `GET /orgx/api/initiatives` → Initiative list

For now, use mock data (same pattern as the /live page's createMockData function) so the dashboard works standalone.

## Steps
1. Set up Vite + React + TypeScript + Tailwind + Framer Motion
2. Create design tokens + shared components (PremiumCard, Modal, Badge, etc.)
3. Build layout components (header, three-column, mobile nav)
4. Build agent panel + components
5. Build activity stream + components  
6. Build initiative panel + components
7. Build decision components
8. Build onboarding wizard
9. Wire up hooks with mock data
10. Create App.tsx that composes everything
11. Create index.html entry point
12. Verify `npm run build` produces dist/ output

## Output
When done, `dashboard/dist/` should contain a built SPA that can be served as static files.
The build should produce: index.html + assets/ (JS + CSS bundles).

IMPORTANT: Run `npm install` first, then `npm run build` to verify everything compiles.
Commit your work when done.
