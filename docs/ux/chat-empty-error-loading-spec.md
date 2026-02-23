# Chat Empty, Error, and Loading States

This document defines deterministic behavior for non-happy-path states.

## Empty States

### No Threads

- Message: orient user to first action.
- Primary CTA: start first thread.
- No decorative filler that competes with CTA.

### No Search Results

- Reflect active query/filter context.
- Provide clear `clear filters/search` action.

### No Artifacts

- Explain artifacts appear after run outputs are produced.
- Offer launch or view timeline action.

## Loading States

- Skeleton shape mirrors final layout.
- Composer remains usable unless action-specific lock applies.
- Thread panel skeleton keeps section geometry stable.

## Error States

### Send Failure

- Keep draft intact.
- Inline retry action.
- Explain persistence state.

### Launch Blocked

- Show reason category.
- Provide immediate remediation action.

### Sync Pending/Offline

- Explicit pending sync status.
- Replay expectation text.

## Copy Contract

Every error state must include:
- what failed
- what was preserved
- what to do next

## QA Matrix

1. Initial load skeleton.
2. Send failure and retry.
3. Launch blocked by guardrails.
4. Offline send and reconnect replay.
