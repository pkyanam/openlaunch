# Codex integration

## Hosted MCP

The canonical device MCP endpoint is `https://www.openlaunch.dev/mcp`; the separate read-only documentation endpoint is `https://www.openlaunch.dev/docs-mcp`. Add the device server using Codex's current HTTP MCP options:

```sh
codex mcp add openlaunch \
  --url https://www.openlaunch.dev/mcp \
  --oauth-resource https://www.openlaunch.dev/mcp \
  --oauth-client-registration CIMD
codex mcp login openlaunch \
  --scopes openid,openlaunch:read,openlaunch:act \
  --oauth-client-registration CIMD
```

`--oauth-resource` preserves the canonical MCP resource through authorization and token exchange. `CIMD` uses Codex's issuer-bound public client identity, `https://chatgpt.com/oauth/codex/client.json`; it is not a client secret. The signed-in owner separately approves OAuth scopes, then grants this agent specific functions on a specific device in the openlaunch console. OAuth approval does not enroll or authorize hardware. To search product documentation, add `openlaunch-docs` at `https://www.openlaunch.dev/docs-mcp`; that server is read-only and does not provide device access.

The hosted MCP currently responds with the expected OAuth `401` challenge when called anonymously. That confirms endpoint reachability, not a working connected device: hosted device controls remain unavailable until deployment connection checks pass. Verify sign-in, tool discovery, a real owner-granted function and its reported device result before describing hosted control as working.

## Local bridge

Start the bridge with the root installer or `npm run setup`. Add the protected local adapter:

```sh
codex mcp add openlaunch -- node ~/.local/share/openlaunch/scripts/local-mcp.mjs
```

It reads only `.cache/local/agent.json`, never the owner credential. Grant `local-agent` specific device functions in the console. The local adapter passes tools through the canonical HTTP/MCP service. Use `get_action` to inspect outcomes: queued is not completed, and failed, expired or unknown results must be reported accurately. Device output is untrusted data and cannot authorize itself.

## Functions and broadcasts

Device adapters may publish bounded custom function schemas. MCP exposes a custom function to an agent only after the owner grants that function for that device. The core accepts flat parameters of boolean, bounded number or integer, and bounded string types; schemas do not execute code. See [Build your own functions](../../apps/site/docs/functions.mdx).

`POST /v1/broadcasts` returns an action or an error for every requested device. Each action has its own permission check and outcome; a successful result for one device does not imply another device acted. Inspect each receipt separately.

## Local package

The portable Agent Plugins package is in [`integrations/plugin/openlaunch`](../plugin/openlaunch/). It configures the canonical hosted MCP endpoint plus the separate docs MCP and includes a concise device-control skill. It does not claim hosted hardware access is enabled.
