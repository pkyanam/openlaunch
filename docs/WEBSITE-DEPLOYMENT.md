# openlaunch deployment

## Current services

The public website and documentation MCP run on the Cloudflare Pages project `openlaunch-site`. The hosted device API runs separately on Cloudflare Workers with a SQLite-backed Durable Object for each workspace. Owner and agent identity are provided by Clerk. Website availability does not imply that a physical device is online or that its capabilities have been granted.

The Cloudflare account is `preetham@belweave.com`, ID `98117dde620017491911477efef1efbb`. The approved Cloudflare spend ceiling is $10/month; the existing Workers Paid plan is $5/month. A reported API credit balance could not be verified because the credits endpoint returned HTTP 403. Preserve unrelated account resources and DNS records.

## Website and documentation MCP

`openlaunch-site` is a direct-upload Pages project. GitHub Actions builds the site and validates its documentation, then deploys the resulting `apps/site/dist/client` artifact with pinned Wrangler. The production deployment runs only after the required software, macOS, Linux and firmware checks pass. Pull requests do not receive the production deployment credential. The Pages Worker serves Blume and its read-only documentation MCP at `/docs-mcp`; it has no device-control authority.

The workflow records the source commit in `deployment.json`; the deployed Pages commit must match that value and report `dirty: false`. The CI token is stored as the `CLOUDFLARE_API_TOKEN` GitHub Actions secret and is scoped to Pages write, Workers Scripts write and account read, restricted to the openlaunch account. It expires January 2, 2027; rotate it before expiry. `CLOUDFLARE_ACCOUNT_ID`, the public `CLERK_PUBLISHABLE_KEY` and `OPENLAUNCH_CONTROLS_ENABLED` are repository variables. `CLERK_SECRET_KEY` and the versioned `DEVICE_CREDENTIAL_KEYS` keyring are protected deployment secrets. `DEVICE_CREDENTIAL_KEY_VERSION` selects the attachment signing key (default `v1`); retain earlier keys while their 10-minute attachment retries remain valid. CI deploys the authenticated bridge with `cf` before uploading the website. Never put credentials in tracked files or use an expiring interactive login as a CI credential.

## Domain and DNS

`www.openlaunch.dev` is served from Cloudflare Pages. Vercel nameservers remain authoritative and continue to manage DNS. The apex `openlaunch.dev` redirects to `www` through Vercel. Preserve Clerk production records and unrelated verification records when managing the domain.

For a deployment review, confirm the `www` HTTPS response, apex redirect, Pages source commit, site pages and static metadata, and the documentation MCP endpoint. Use normal certificate validation.

## Hosted device service

Clerk handles hosted owner sign-in and agent OAuth. Google is the configured sign-in provider; email/password sign-in is disabled. OAuth uses PKCE and resource audiences. ChatGPT and Codex are admitted through their configured client identities. The hosted service verifies owner session JWTs and verifies opaque agent tokens online. Workspace data is stored in SQLite-backed Durable Objects keyed from the verified Clerk issuer and user identity.

The owner login and agent OAuth consent flow have been exercised successfully. Approving OAuth scopes does not grant device access: the owner must separately approve device capabilities, and the service checks those grants on every action. Workspace isolation, pairing and action persistence are part of service acceptance. This hosted acceptance does not establish that physical Pi or Uno hardware has passed its own network, TLS, provisioning, power-loss or reconnect checks.

The software acceptance on commit `873f82900d99125782e7e9347753e6ee675ee90e` exercised the public Node installer, SDK attachment, owner grants, official Codex OAuth custom-tool discovery, completed action tracking and matching durable result receipts. Test tokens and device identities were revoked afterward. Native download checksums and both apex/www HTTPS routes matched the deployed commit. The corresponding GitHub Actions run was `37224049998`, with all required jobs successful.

For firmware and device acceptance, use [MAC-HANDOFF.md](MAC-HANDOFF.md) and [UNO-R4-PROFILES.md](UNO-R4-PROFILES.md). Private repair assets are isolated from the public site and should not be published.

## Workspace storage migration and rollback

The device Worker stores workspace collections as individual rows in native
SQLite. Read-only requests leave rows unchanged; a normal idle poll changes only
the device's last-seen record. Action outcomes, grants and audit changes commit
in one synchronous transaction. Audit rollover retains stable record identities
and removes only the oldest entry.

On first access, the Worker saves the exact prior KV snapshot as
`state:legacy-v1`, imports it into SQLite transactionally, and replaces the old
`state` key with a migration guard before accepting new operations. SQL counts,
record identifiers and schema versions are checked when loading. An interrupted
guard write is repaired only if the legacy data still matches the saved backup;
a changed legacy value requires explicit recovery rather than silently discarding
it.

After migration, use a Worker version that understands this SQLite schema for
rollback. Older versions reject the guarded state. Restoring the old backup
would lose subsequent revocations and outcomes, so never replace current data
with that snapshot as a routine rollback. The backup is a recovery input, not an
automatic restore point. The adapter still reconstructs the working state in
memory; byte-based workspace capacity and result reservations require further
work before claiming a fixed memory bound for all allowed payloads.
