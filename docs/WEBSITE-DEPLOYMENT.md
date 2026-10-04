# openlaunch deployment

## Current services

The public website and documentation MCP run on the Cloudflare Pages project `openlaunch-site`. The hosted device API runs separately on Cloudflare Workers with a SQLite-backed Durable Object for each workspace. Owner and agent identity are provided by Clerk. Website availability does not imply that a physical device is online or that its capabilities have been granted.

The Cloudflare account is `preetham@belweave.com`, ID `98117dde620017491911477efef1efbb`. The approved Cloudflare spend ceiling is $10/month; the existing Workers Paid plan is $5/month. A reported API credit balance could not be verified because the credits endpoint returned HTTP 403. Preserve unrelated account resources and DNS records.

## Website and documentation MCP

`openlaunch-site` is a direct-upload Pages project. GitHub Actions builds the site and validates its documentation, then deploys the resulting `apps/site/dist/client` artifact with pinned Wrangler. The production deployment runs only after the required software, macOS, Linux and firmware checks pass. Pull requests do not receive the production deployment credential. The Pages Worker serves Blume and its read-only documentation MCP at `/docs-mcp`; it has no device-control authority.

The workflow records the source commit in `deployment.json`; the deployed Pages commit must match that value and report `dirty: false`. The CI token is stored as the `CLOUDFLARE_API_TOKEN` GitHub Actions secret and is scoped to Pages write, Workers Scripts write and account read, restricted to the openlaunch account. It expires January 2, 2027; rotate it before expiry. `CLOUDFLARE_ACCOUNT_ID`, the public `CLERK_PUBLISHABLE_KEY` and `OPENLAUNCH_CONTROLS_ENABLED` are repository variables. `CLERK_SECRET_KEY` is a protected deployment secret. CI deploys the authenticated bridge with `cf` before uploading the website. Never put credentials in tracked files or use an expiring interactive login as a CI credential.

## Domain and DNS

`www.openlaunch.dev` is served from Cloudflare Pages. Vercel nameservers remain authoritative and continue to manage DNS. The apex `openlaunch.dev` redirects to `www` through Vercel. Preserve Clerk production records and unrelated verification records when managing the domain.

For a deployment review, confirm the `www` HTTPS response, apex redirect, Pages source commit, site pages and static metadata, and the documentation MCP endpoint. Use normal certificate validation.

## Hosted device service

Clerk handles hosted owner sign-in and agent OAuth. Google is the configured sign-in provider; email/password sign-in is disabled. OAuth uses PKCE and resource audiences. ChatGPT and Codex are admitted through their configured client identities. The hosted service verifies owner session JWTs and verifies opaque agent tokens online. Workspace data is stored in SQLite-backed Durable Objects keyed from the verified Clerk issuer and user identity.

The owner login and agent OAuth consent flow have been exercised successfully. Approving OAuth scopes does not grant device access: the owner must separately approve device capabilities, and the service checks those grants on every action. Workspace isolation, pairing and action persistence are part of service acceptance. This hosted acceptance does not establish that physical Pi or Uno hardware has passed its own network, TLS, provisioning, power-loss or reconnect checks.

For firmware and device acceptance, use [MAC-HANDOFF.md](MAC-HANDOFF.md) and [UNO-R4-PROFILES.md](UNO-R4-PROFILES.md). Private repair assets are isolated from the public site and should not be published.
