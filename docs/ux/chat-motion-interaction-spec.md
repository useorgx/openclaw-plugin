# Chat Motion and Interaction Spec

Motion must communicate causality and state transitions.

## Motion System Rules

- Use tokenized durations from `motion.duration*`.
- Use spring-based interactions for direct manipulation.
- Respect reduced-motion preferences.

## Interaction Physics

- Hover: subtle lift/contrast feedback only.
- Tap: slight compression with quick recovery.
- Focus: always-visible ring using tokenized focus values.

## Transition Patterns

- Composer expand: vertical reveal + opacity.
- Mention menu: anchored fade/slide from trigger.
- Thread panel: directional slide with backdrop fade.
- Status change: value/color interpolation, no bounce theatrics.

## Causality Rules

- User action origin should visually connect to resulting state change.
- Avoid jump-cut swaps for major state transitions.

## Motion Limits

- No continuous pulsing for running states.
- No full-list re-animation on single-item updates.
- Keep decorative motion below content priority.

## Reduced Motion

- Replace movement with opacity-based transitions where needed.
- Preserve information timing and order without relying on motion.

## QA Scenarios

1. Desktop interaction loop (hover, tap, focus).
2. Reduced-motion mode behavior.
3. Rapid send/launch sequence with no stutter.
4. Mobile panel and menu transitions.
