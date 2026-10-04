# Setup status and gates

The monorepo is published at https://github.com/pkyanam/openlaunch. Start with [Mac handoff](MAC-HANDOFF.md). The software can run locally without cloud login; real boards require a reachable trusted HTTPS bridge.

## Cloud rollout still required

1. Sign into the official Cloudflare CLI on the Mac; verify the intended account and openlaunch.dev zone. The cloud workspace's earlier device-code exchange was blocked by network policy.
2. Confirm a spending limit and credit eligibility before provisioning resources. Reported credit is not unlimited spending permission.
3. Configure maintained OAuth provider integration and real owner login. Verify consent, PKCE, requested scopes, refresh/revocation and per-workspace isolation.
4. Restrict openlaunch:owner to owner dashboard sessions. MCP clients get read/act scopes and separately approved device grants.
5. Deploy the Worker, Durable Object and web assets; configure openlaunch.dev and verify TLS. Do not mistake JWT verification code for a complete OAuth provider.
6. Complete Pi/R4 Wi-Fi, reconnect, clock, restart and revocation acceptance on actual hardware.

No OpenAI API key is required for the core MCP bridge. Optional model-based evaluations or voice would need a separate approved integration. No Cloudflare resources or DNS changes have been made by the current implementation.
