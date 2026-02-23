# Chat QA Checklist

Minimum test matrix for every release candidate touching chat UX.

## Desktop Core Flow

1. Create unscoped thread from composer.
2. Send message and verify Activity thread card appears.
3. Open thread panel and verify timeline entries.
4. Set assignee and watchers.
5. Launch and verify queued -> running -> terminal state.

## Initiative Linking

1. Link an existing thread to existing initiative.
2. Promote thread to new initiative.
3. Verify scope chips update in feed and panel.
4. Verify relink history events remain visible.

## Attachments

1. Upload single file success.
2. Upload mixed success/failure files.
3. Retry failed extraction.
4. Launch with non-ready attachment warning path.

## Mobile 375

1. Composer use with keyboard visible.
2. Mention and assignee selection.
3. Thread panel open/close with scroll restoration.
4. Launch lifecycle state visibility.

## Accessibility

1. Keyboard-only end-to-end flow.
2. Screen reader launch status announcements.
3. Focus restoration on panel/modal close.

## Regression

1. Activity filters/search/sort still work for non-chat items.
2. Sessions panel behavior unchanged for existing run/session flows.

## Evidence Capture (Required)

Desktop screenshots:
- composer idle
- composer expanded
- activity thread card running
- thread panel with launch timeline
- blocked state with remediation

Mobile screenshots (375):
- composer expanded with keyboard
- thread panel open
- launch transition state
- completed state

## Exit Rule

- No unresolved critical or major failures.
- All required evidence artifacts attached to QA run.
