# Chat Attachments Spec

Defines attachment handling for metadata-first v1.

## Scope

- Files are attached to conversation context.
- Attachment metadata and extraction status are visible in UI.
- Launch can proceed with non-ready files when user confirms.

## Input Methods

- File picker
- Drag-and-drop
- Clipboard paste (where supported)

## Attachment Chip Anatomy

- filename
- mime/type hint
- size
- status (`preparing`, `indexing`, `ready`, `failed`)
- remove/retry action

## Lifecycle Rules

| Status | Meaning | Allowed Actions |
|---|---|---|
| preparing | file accepted locally | cancel |
| indexing | metadata extraction in progress | cancel |
| ready | extraction complete | launch, remove |
| failed | extraction failed | retry, remove, launch with warning |

## Launch Interaction

- If all ready: normal launch.
- If mixed readiness: launch warning sheet lists affected attachments.
- User can proceed or cancel and retry extraction.

## Error Strategy

- Unsupported type: immediate inline reason.
- Extraction failure: preserve attachment ref and surface retry.
- Network interruption: mark pending sync and replay on reconnect.

## Security/Privacy Rules

- Collapsed composer never reveals attachment content.
- Only minimal metadata appears in feed cards.
- Sensitive file names can be masked if policy requires.

## QA Scenarios

1. Single upload success.
2. Multiple uploads with mixed results.
3. Retry failed extraction.
4. Launch with one failed attachment and confirmation path.
