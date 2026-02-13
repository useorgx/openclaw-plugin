# Security

This document explains what the OrgX OpenClaw plugin stores, how authentication works, and how to avoid leaking sensitive data into prompts.

## Data Stored

The plugin stores:
- An OrgX credential (`oxk_...`) in OpenClaw's credential store after browser pairing, or a manually entered key if you choose that path.
- Local configuration (plugin config + runtime state) required to run the dashboard and background sync.
- Optional MCP client autoconfig backups (if enabled) when patching local MCP config files.

The plugin does not intentionally store:
- Your OpenAI/Anthropic/provider API keys (BYOK keys stay in OpenClaw settings).
- Raw files from your repositories.

## Authentication Model

Supported auth modes:
1. Browser pairing: you authenticate on `useorgx.com` and approve the connection. The plugin stores a scoped OrgX key.
2. Manual API key entry: you provide an `oxk_...` key directly.

The plugin uses the stored OrgX key to call OrgX APIs and to expose the local MCP bridge endpoint at `/orgx/mcp`.

## Prompt Hygiene (Avoid PII / Secrets)

When using the MCP tools:
- Do not paste secrets (API keys, passwords, tokens) into prompts.
- Prefer referencing files by path and letting tools read only what is necessary.
- Avoid sharing customer PII in agent prompts. Use redacted examples.

If you believe you accidentally shared sensitive data:
- Rotate the affected secret immediately.
- Revoke the OrgX key and re-pair.

## Reporting a Vulnerability

If you discover a security issue:
- Do not open a public issue with exploit details.
- Email the OrgX team with reproduction steps and impact.

## Development Notes

When developing the plugin locally:
- Prefer using a test OrgX account and minimal-permission keys.
- Keep `.bak.*` backups of MCP config files out of git.

