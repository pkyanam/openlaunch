# openlaunch Agent Plugin

This is a portable Agent Plugins 1.0 package for ChatGPT and Codex. It connects to the canonical openlaunch device MCP at `https://www.openlaunch.dev/mcp`, the separate read-only docs MCP at `https://www.openlaunch.dev/docs-mcp`, and includes a skill for safe device-control workflows. Its icon and logo use the existing lowercase openlaunch artwork from the site.

New linked agents receive all device functions by default. Owners can exclude devices or functions in **Connections → Agents**; existing selected-function connections keep their restrictions. AgentID identities can create their own isolated workspace or join an owner's workspace by invitation. Administrators can set up adapters through the management tools, while setup tokens remain separate from runtime credentials. A queued action is only a receipt; use `get_action` to inspect the final device outcome.

The hosted `/mcp` endpoint currently enforces OAuth. Hosted device controls are still deployment-gated; a reachable authenticated endpoint does not mean hardware control has been verified. See [ChatGPT integration status](../../chatgpt/README.md) and [Codex setup](../../codex/README.md).

The portable manifest and MCP server configuration are at this directory's root. Do not submit this package to a public plugin directory until the hosted connection checks, granted-device workflow and real action outcomes have been verified.
