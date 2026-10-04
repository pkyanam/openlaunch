# ChatGPT integration

The canonical device MCP endpoint is `https://www.openlaunch.dev/mcp`. It uses Clerk OAuth and the MCP protected-resource metadata at `https://www.openlaunch.dev/.well-known/oauth-protected-resource`. The separate `https://www.openlaunch.dev/docs-mcp` endpoint is read-only documentation search; it does not grant access to devices. Do not register the docs endpoint as the device server or substitute it for `/mcp`.

The hosted endpoint is deployed and responds with the expected OAuth `401 Unauthorized` challenge when called without an approved agent token. This verifies reachability and authentication enforcement only. Hosted controls are enabled after authenticated software acceptance. Physical device acceptance remains separate; see the verification guide.

An owner must first connect the openlaunch account through OAuth and consent to requested MCP scopes. OAuth consent only connects the account. In the openlaunch console, the owner separately grants a particular agent specific functions on a particular device until revoked or with an expiry. No device is enrolled and no hardware permission is created by installing the plugin or signing in.

The `integrations/plugin/openlaunch` folder contains the portable Agent Plugins 1.0 package. It bundles the device-control skill and both MCP endpoints. Custom adapter functions use the bounded schemas described in [the function guide](../../apps/site/docs/functions.mdx); only functions explicitly granted to that agent are discoverable. For multi-device calls, `/v1/broadcasts` returns a separate action or error for each device. A queued response is a receipt, not proof of execution: inspect each action through `get_action` and report its actual terminal outcome.

Before calling this hosted integration production-ready, verify the OAuth discovery, PKCE, audience and scope enforcement, refresh and revocation behavior, tool discovery after a real per-device grant, and real device outcomes. Never claim hardware was verified based only on endpoint reachability or an OAuth login.
