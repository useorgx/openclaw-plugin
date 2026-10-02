import { avatarConfig } from '@useorgx/orgx-ui-kit/elements';

/**
 * Point <ox-avatar> at the renders that ship with the dashboard
 * (dashboard/public/avatars, synced by scripts/sync-ui-kit.mjs). The plugin
 * serves the dashboard under a CSP of img-src 'self', so the kit's default
 * (mcp.useorgx.com) would be blocked.
 */
export function configureOrgxKit(): void {
  avatarConfig.baseUrl = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/avatars`;
}
