# openlaunch deployment

The owner approved a $10/month ceiling and Vercel DNS with `www` first. Credit applicability remains unverified because the credits API returned 403. The Cloudflare account is `preetham@belweave.com`, ID `98117dde620017491911477efef1efbb`. Preserve unrelated resources and DNS.

## Website and documentation MCP

`openlaunch-site` is a direct-upload Pages project, created with the pinned official `cf` CLI. The owner later authorized Wrangler as a fallback: the current `cf pages deploy` directory-upload command does not upload assets, and Cloudflare rejected Git project creation with error 8000011 despite the GitHub app having All Repositories access. GitHub Actions provides CI/CD without that installation association.

The software job builds Blume and validates all docs, then uploads the site artifact including `.well-known` discovery files. The deployment job requires macOS, Linux and firmware checks to pass. It downloads that exact artifact and uploads `apps/site/dist/client` through pinned Wrangler with bundling disabled. The commit recorded by Pages must match `deployment.json.commit`, with `dirty: false`. PRs do not receive the deployment credential or publish production.

`CLOUDFLARE_API_TOKEN` is a GitHub Actions secret scoped to Pages write and account read for this account. It expires January 2, 2027 and must be rotated before then. `CLOUDFLARE_ACCOUNT_ID` is a repository variable. Never use an expiring interactive OAuth token as a CI credential.

The Pages advanced-mode Worker runs Blume's built-in read-only MCP handler at `/docs-mcp`, with the same generated documentation corpus. Device controls use a separate authenticated service. Both Pages environments have fail-open disabled.

## Domain

Vercel nameservers are authoritative. Add `www.openlaunch.dev` with `cf pages domains create openlaunch-site --name www.openlaunch.dev`, inspect the returned Pages target, then add only the required `www` CNAME through Vercel. Preserve Clerk production records and unrelated verification records. Do not change nameservers.

Verify authoritative DNS, normal HTTPS certificate checks, documentation, MCP discovery, Markdown pages, and both source commit stamps. Apex HTTPS redirection requires a separate redirect deployment at Vercel; an external Pages CNAME alone does not configure the apex.

## Hosted bridge acceptance

Clerk is the hosted identity provider. PKCE is required, OAuth access tokens are opaque and verified online, resource audiences are enabled, and unknown clients cannot self-register. ChatGPT and Codex use their admitted CIMD identities. Owner sessions and agent OAuth identities stay separate; OAuth scope approval does not create device capability grants.

Before enabling hosted linking, test real owner login, consent, audience binding, refresh/revocation, workspace separation, pairing, receipt/result persistence and grant revocation. Hardware acceptance remains separate: follow `MAC-HANDOFF.md` and `UNO-R4-PROFILES.md`, keeping custom ESP firmware and private repair assets untouched.
