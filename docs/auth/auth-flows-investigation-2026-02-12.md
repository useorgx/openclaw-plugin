# Auth Flows Investigation (Clerk, MCP, ChatGPT, OpenClaw)

Date: 2026-02-12
Scope:
- Clerk (OrgX web auth)
- OrgX MCP server auth (OAuth)
- ChatGPT integration surface(s)
- OpenClaw plugin onboarding (browser pairing + API keys)

This doc maps how identity and sessions move across the system today, with specific code pointers.

## Glossary: IDs and Secrets

Identity IDs:
- Clerk user id ("external id"): `user_...`
- Supabase user id (internal): UUID `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`

Secrets / tokens:
- User API key: `oxk_...` (44 chars). Stored hashed server-side; presented as `Authorization: Bearer oxk_...`.
- Service key (gateway-to-app): `ORGX_SERVICE_KEY` (expected prefix `oxk-...`). Presented as `Authorization: Bearer $ORGX_SERVICE_KEY`.
- MCP OAuth access token: minted by the Cloudflare OAuthProvider and presented as `Authorization: Bearer <token>` to `https://mcp.useorgx.com/*`.
- OpenClaw pairing tokens: `pollToken` and `claimToken` (opaque random strings). Never become long-lived auth.

Key invariant (current):
- "User identity" propagated from Clerk into server-to-server calls is generally the Clerk external id (`user_...`) and must be normalized to a Supabase UUID before touching UUID-typed columns.

## Flow A: OpenClaw Plugin Browser Pairing (Recommended)

Components:
- Local OpenClaw plugin (this repo)
- OrgX web app (Clerk)
- OrgX pairing API + DB (Supabase)

### A1. Local plugin starts pairing

Code (OpenClaw plugin):
- `src/index.ts` (startPairing): `POST /api/plugin/openclaw/pairings`
- `dashboard/src/hooks/useOnboarding.ts` opens the returned `connectUrl` in a browser window

API (OrgX core repo):
- `orgx/app/api/plugin/openclaw/pairings/route.ts`
- `orgx/lib/server/openclawPairing.ts` (createPairingSession)

Behavior:
1. Plugin calls `POST ${baseUrl}/api/plugin/openclaw/pairings` with `installationId`, `pluginVersion`, etc.
2. OrgX returns:
   - `pairingId`
   - `pollToken`
   - `connectUrl` = `${appBaseUrl}/connect/openclaw?pairingId=...&claimToken=...`
3. Plugin transitions to `awaiting_browser_auth` then polls status.

### A2. Browser connect URL (Clerk gate) and claim

Code (OrgX core repo):
- `orgx/app/connect/openclaw/page.client.tsx`:
  - if not authenticated, redirects to `/sign-in?redirect_url=<this page>`
  - on "Connect": fetches CSRF and calls claim endpoint

Claim endpoint:
- `orgx/app/api/plugin/openclaw/pairings/[pairingId]/claim/route.ts`

Security gates:
- Clerk session: `currentUser()` must exist
- CSRF: `verifyCsrf(request)`
- Claim token: hashed compare with `claim_token_hash`

Key issuance:
- Claim endpoint calls `createUserApiKey({ userId: user.id, source: 'openclaw-plugin', rotateExisting: true, ... })`
- Key is encrypted and stored in `plugin_pairing_sessions.encrypted_api_key`
- Response includes `keyPrefix` (but not the full key)

### A3. Plugin polls for ready and receives the key (one-time delivery)

Code (OpenClaw plugin):
- `src/index.ts` (getPairingStatus):
  - `GET /api/plugin/openclaw/pairings/:pairingId?pollToken=...`
  - when status is `ready`, expects `key` in response and persists it

Code (OrgX core repo):
- `orgx/app/api/plugin/openclaw/pairings/[pairingId]/route.ts`:
  - validates `pollToken`
  - decrypts `encrypted_api_key` and returns `key`
  - sets `delivered_at` on first successful delivery

### A4. Plugin acknowledges consumption

Code (OpenClaw plugin):
- `src/index.ts` POSTs `/api/plugin/openclaw/pairings/:pairingId/ack` with `pollToken`

Code (OrgX core repo):
- `orgx/app/api/plugin/openclaw/pairings/[pairingId]/ack/route.ts`:
  - transitions status to `consumed`
  - clears `encrypted_api_key` (prevents later recovery)

### A5. Local key storage

Code (OpenClaw plugin):
- `src/auth-store.ts` persists `auth.json` with `0o600` and `~/.config/useorgx/openclaw-plugin` as `0o700`.

Record fields:
- `apiKey`
- `source`: `browser_pairing`
- `installationId`
- `workspaceName`, `keyPrefix`

## Flow B: OpenClaw Plugin Manual API Key (Fallback)

Code (OpenClaw plugin):
- UI submits to `POST /orgx/api/onboarding/manual-key` (local handler)
- local handler probes via `OrgXClient.getOrgSnapshot()` to validate

Relevant code:
- `dashboard/src/hooks/useOnboarding.ts` (submitManualKey)
- `src/http-handler.ts` (manual key route): accepts key in JSON, `Authorization: Bearer`, `X-OrgX-Api-Key`
- `src/index.ts` (submitManualKey): probes `GET/POST /api/client/sync`

Server auth (OrgX core repo):
- `orgx/lib/server/auth/apiKeyAuth.ts`
  - extracts bearer token
  - checks `oxk_` prefix and `key_prefix`
  - validates `sha256(key)` against stored `key_hash`
  - resolves API key `user_id` (Clerk external id) to Supabase UUID via `resolveSupabaseUserIdForExternal(..., createIfMissing=false)`

## Flow C: MCP Server OAuth (Clerk-backed)

Components:
- MCP server: Cloudflare worker at `https://mcp.useorgx.com`
- Clerk sign-in in OrgX web app

Code (OrgX core repo):
- MCP OAuth handler: `orgx/workers/orgx-mcp/src/authHandler.ts`
- Web callback page: `orgx/app/auth/mcp/callback/page.tsx`

High-level sequence:
1. MCP client hits `GET https://mcp.useorgx.com/authorize?...`.
2. MCP server stores OAuth request in KV and redirects to `https://useorgx.com/sign-in?redirect_url=https://useorgx.com/auth/mcp/callback?state_key=...`.
3. After Clerk sign-in, `orgx/app/auth/mcp/callback/page.tsx` redirects to `https://mcp.useorgx.com/oauth/callback?state_key=...&user_id=<clerk user id>&...`.
4. MCP server shows consent UI (consent.html) and then completes authorization via OAuthProvider.

Important detail:
- OAuthProvider `userId` is currently the Clerk user id (`user_...`), not a Supabase UUID.

## Flow D: MCP Worker -> OrgX API (Service key + propagated user identity)

Code (OrgX core repo):
- `orgx/workers/orgx-mcp/src/orgxApi.ts` uses `ORGX_SERVICE_KEY` and sets `X-Orgx-User-Id` when provided.
- `orgx/lib/server/auth/serviceKey.ts` defines and extracts `X-Orgx-User-Id`.

Normalization on the app side:
- Client integration writes (example): `orgx/app/api/client/live/activity/route.ts` delegates to `resolveClientWriteAuth()`.
- `orgx/lib/server/auth/clientWriteAuth.ts` resolves `X-Orgx-User-Id` via `resolveSupabaseUserIdForExternal(..., createIfMissing=false)`.

Implication:
- For service-key authenticated requests, `X-Orgx-User-Id` can safely be the Clerk external id as long as the handler normalizes it before using it as a UUID.

## Flow E: ChatGPT Tool Execution Surface

Observed in OrgX core repo:
- `orgx/app/api/chatgpt/tools/route.ts` requires service-key auth and accepts an optional `user_id` in the JSON body.
- `normalizeChatgptRouteUserId()` resolves `user_id` (UUID or Clerk external id) to a Supabase UUID via `resolveSupabaseUserIdForExternal(createIfMissing=false)`.

Notes:
- This route is not Clerk-session authenticated. It is designed for the MCP worker (service key) to call.

## Findings and Root-Cause Hypotheses

### 1. ID normalization happens at boundaries, but not uniformly

Patterns that work:
- API-key auth: `authenticateApiKey()` always resolves external id -> UUID (`orgx/lib/server/auth/apiKeyAuth.ts`).
- Service-key client writes: `resolveClientWriteAuth()` resolves external id -> UUID (`orgx/lib/server/auth/clientWriteAuth.ts`).
- Entities API resolves external id -> UUID before insert/list (`orgx/app/api/entities/route.ts`).

Risk pattern:
- Any service-key route that uses `extractGatewayUserId()` directly without resolving to a UUID before DB writes can cause "invalid UUID" failures or cross-table mismatches.

### 2. Pairing key decrypt failures can look like "random re-auth required"

OrgX pairing key encryption uses a derived secret (`orgx/lib/server/openclawPairing.ts`):
- Preferred: `OPENCLAW_PAIRING_SECRET`
- Fallbacks: `ORGX_SERVICE_KEY`, `SUPABASE_JWT_SECRET`

If this derived secret changes between claim and poll, polling can hit `decrypt_failed` and the plugin will be forced back to manual-key mode.

### 3. OpenClaw plugin intentionally avoids coupling oxk_ keys to X-Orgx-User-Id

Code (OpenClaw plugin):
- `src/contracts/client.ts` only sets `X-Orgx-User-Id` for non-`oxk_` keys.
- `src/auth-store.ts` sanitizes persisted auth so `userId` is null for `oxk_` keys.

This is consistent with OrgX core expecting the API key itself to establish identity.

## Quick Test Checklist (Local)

OpenClaw plugin repo:
- `npm run typecheck`
- `npm run test:hooks`

OrgX core repo (if you need to validate end-to-end pairing):
- Pairing unit specs:
  - `orgx/tests/api.openclaw.pairings.spec.ts`
- Pairing E2E:
  - `orgx/tests/e2e/openclaw-pairing.e2e.ts`

