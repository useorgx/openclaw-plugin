# Agents / Chats Panel Redesign Notes

This doc is the rationale + checklist behind the Agents/Chats panel (session roster) changes.

## Problems Observed (Before)

- Offline filtering was hidden behind a `<select>` even on desktop, which made “where did my sessions go?” harder to answer quickly.
- Session group headers didn’t encode “how many sessions are here?” or “what status am I looking at?” at a glance.
- Child session rows didn’t communicate status + recency cleanly.
- Archived disclosure could feel accidental (hidden at the bottom without context).

## Changes Implemented (After)

### Offline Filter

- Desktop: a segmented chip group for the offline window (`All`, `24h`, `3d`, `7d`, `30d`).
- Mobile: keeps the `<select>` to avoid overflow and keep tap targets predictable.

### Group Rows

- Group header now includes:
  - Session count chip when a group has multiple sessions.
  - Explicit status chip for the lead session.
- Child sessions show:
  - Provider mark + title + status + recency.
  - A status dot at the end for fast scanning.

### Microcopy

- “No run summary yet…” shortened to “No summary yet…” while still telling the user what to do next.

## QA Screenshot States (Minimum)

- Agent with:
  - One running session (lead progress visible).
  - Multiple sessions (child list expanded).
  - Archived sessions hidden by offline filter (archived disclosure visible).
- Empty state:
  - No sessions and no reconnect available.
  - No sessions with reconnect available (OrgX roster shows Connect buttons).

