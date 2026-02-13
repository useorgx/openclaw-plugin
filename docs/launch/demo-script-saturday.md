# Demo Script (Saturday Launch)

Goal: show the full flow from zero to visible autonomous progress, end-to-end.

## Setup (Before Recording)

- OpenClaw is installed and running.
- Plugin installed: `openclaw plugins install @useorgx/openclaw-plugin`
- Start from a clean browser session (or incognito) if you want the pairing flow on camera.
- Have the OrgX website logged out (optional).

## Flow (On Camera)

1. Open OrgX dashboard
   - Visit `http://127.0.0.1:18789/orgx/live`
   - Show "Connect OrgX" if not paired.

2. Pair / Authenticate
   - Click **Connect OrgX**
   - Complete sign-in + approve connection on `useorgx.com`
   - Return to OpenClaw
   - Confirm the dashboard shows initiatives / activity and that the connection is "healthy".

3. Scaffold an initiative
   - In OpenClaw chat, prompt:
     - "Plan a product launch"
   - Watch for scaffold result:
     - "Created X entities"
     - Live link printed
     - Launch/streams summary (streams created + dispatched)

4. Show auto-continue starting
   - Open the live link: `https://useorgx.com/live/<initiativeId>?view=mission-control`
   - Confirm streams show `ready/active` and progress starts moving.
   - Narrate: "Agents are now executing the first workstream automatically."

5. Ask "what should I do next?"
   - In chat: "What should I do next?"
   - Expect:
     - `recommend_next_action` includes active agent/stream progress (e.g. "Agents running: marketing (25%) ...")
     - Suggested parallel workstream to review.

6. Completion + artifact visibility
   - Wait for one stream to complete (or fast-forward if needed).
   - Confirm artifacts show up in the initiative live view (and/or relevant activity feed).

## Backup Lines (If Something Breaks Live)

- "If agents don't start automatically, you can say 'start agents' to re-trigger dispatch."
- "You can also pick a single workstream to focus on and dispatch it manually."

## Success Criteria

- Scaffold returns a live link.
- Streams exist and at least one stream transitions to `active`.
- Progress updates are visible (even coarse %).
- At least one artifact is present and linked to the initiative/run.

