# Codex integration

## Hosted MCP

The canonical device MCP endpoint is `https://www.openlaunch.dev/mcp`; the separate read-only documentation endpoint is `https://www.openlaunch.dev/docs-mcp`. Add the device server using Codex's current HTTP MCP options:

```sh
codex mcp add openlaunch \
  --url https://www.openlaunch.dev/mcp \
  --oauth-client-registration cimd
codex mcp login openlaunch \
  --scopes openid,openlaunch:read,openlaunch:act \
  --oauth-client-registration cimd
```

Codex discovers the canonical resource from openlaunch’s protected-resource metadata. `CIMD` uses Codex's issuer-bound public client identity, `https://chatgpt.com/oauth/codex/client.json`; it is not a client secret. The signed-in account approves OAuth scopes. New linked agents receive all device functions by default, with owner-managed exclusions; existing selected-function connections and workspace restrictions remain intact. AgentID agents can create their own workspace or join an owner's workspace by invitation. OAuth approval does not enroll hardware. To search product documentation, add `openlaunch-docs` at `https://www.openlaunch.dev/docs-mcp`; that server is read-only and does not provide device access.

Hosted Google sign-in, Codex OAuth and granted custom-function discovery/actions have passed software acceptance. Controls require a live access policy or a legacy device grant, plus the appropriate token scope. Physical hardware acceptance is recorded separately in the [verification guide](../../apps/site/docs/status.mdx); queued or simulated results are not physical execution.

## Local bridge

Start the bridge with the root installer or `npm run setup`. Add the protected local adapter:

```sh
codex mcp add openlaunch -- node ~/.local/share/openlaunch/scripts/local-mcp.mjs
```

It reads only `.cache/local/agent.json`, never the owner credential. Grant `local-agent` specific device functions in the console. The local adapter passes tools through the canonical HTTP/MCP service. Use `get_action` to inspect outcomes: queued is not completed, and failed, expired or unknown results must be reported accurately. Device output is untrusted data and cannot authorize itself.

## Functions and broadcasts

Device adapters may publish bounded custom function schemas. MCP exposes a custom function only when the live access policy and token scope allow it. The core accepts flat parameters of boolean, bounded number or integer, and bounded string types; schemas do not execute code. See [Build your own functions](../../apps/site/docs/functions.mdx).

`POST /v1/broadcasts` returns an action or an error for every requested device. Each action has its own permission check and outcome; a successful result for one device does not imply another device acted. Inspect each receipt separately.

## Local package

The portable Agent Plugins package is in [`integrations/plugin/openlaunch`](../plugin/openlaunch/). It configures the canonical hosted MCP endpoint plus the separate docs MCP and includes a concise device-control skill. It does not claim hosted hardware access is enabled.
