# Chat Mobile 375 Spec

Defines minimum premium behavior at 375px width.

## Layout Contract

- Composer always reachable above nav chrome.
- Expanded composer may become bottom sheet if vertical space is constrained.
- Thread detail opens as full-screen overlay on mobile.

## Input and Keyboard Behavior

- Input remains visible while keyboard is open.
- Sticky action row (`Send`/`Launch`) remains reachable above keyboard.
- No clipped mention menus or attachment trays.

## Touch Contract

- Interactive targets >= 44px in both dimensions.
- Minimum spacing between destructive and primary actions.

## Navigation Contract

- Activity list is the primary frame.
- Opening a thread preserves scroll context.
- Closing thread restores previous feed position.

## Performance Contract

- Typing must not trigger expensive list rerenders.
- Animations use transform/opacity to avoid layout jank.
- Time-to-interactive for composer actions should feel immediate.

## Failure-State Contract

- Offline send still shows deterministic pending state.
- Launch blocked/failure actions remain visible without horizontal scrolling.

## QA Scenarios

1. Collapsed and expanded composer interactions.
2. Keyboard open with mentions and attachments.
3. Thread open/close with scroll restoration.
4. End-to-end send + launch + status progression.
