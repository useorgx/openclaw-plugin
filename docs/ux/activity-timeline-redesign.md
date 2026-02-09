# Activity Timeline Redesign Notes

This doc is the rationale + checklist behind the Activity timeline header + row layout changes.

## Problems Observed (Before)

- Header controls competed for attention (sort/collapse, filter chips, search) and reflowed awkwardly at narrow widths.
- Rows mixed multiple “metadata languages” (chips + uppercase type + duplicated timestamps), making scanning slower.
- “Who / what / when / status” was not consistently legible in the first 1-2 seconds of a row.

## Changes Implemented (After)

### Header

- Clear hierarchy:
  - Title + counts (`filtered.length`, `truncatedCount`) next to the header label.
  - Session filter presented as a single pill with an embedded “×”.
  - Actions simplified to two consistent pills: `Newest/Oldest` and `Compact/Expand`.
- Filter chips moved into a single segmented group, so it stays stable on mobile.

### Row Layout

- Rows now lead with:
  - **What**: title (2-line clamp, break-words).
  - **Who**: agent name (with avatar as an anchor).
  - **When**: absolute time (top-right) + relative time (chip row).
  - **Status**: session status chip when available.
- Removed the redundant “Open details” affordance and reduced hover motion (no scaling).

## QA Screenshot States (Minimum)

- Multi-session mode:
  - Normal feed with 50+ events.
  - Search empty state.
  - Filter empty state.
- Session filtered:
  - Session pill visible; clearing works.
  - Detail modal shows `Focus session` CTA.
- Degraded/unauthorized:
  - Banner/copy clarity and next action.

