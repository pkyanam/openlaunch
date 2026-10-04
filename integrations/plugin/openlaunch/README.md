# openlaunch Agent Plugin

This is a portable Agent Plugins 1.0 package for ChatGPT and Codex. It connects to the canonical openlaunch device MCP at `https://www.openlaunch.dev/mcp`, the separate read-only docs MCP at `https://www.openlaunch.dev/docs-mcp`, and includes a skill for safe device-control workflows. Its icon and logo use the existing lowercase openlaunch artwork from the site.

The OAuth connection and device permission are separate steps. After signing in and consenting to requested scopes, the device owner must grant this agent specific functions on a specific device in the openlaunch console. A queued action is only a receipt; use `get_action` to inspect the final device outcome. Custom function tools appear only after their per-device grant.

The hosted `/mcp` endpoint currently enforces OAuth. Hosted device controls are still deployment-gated; a reachable authenticated endpoint does not mean hardware control has been verified. See [ChatGPT integration status](../../chatgpt/README.md) and [Codex setup](../../codex/README.md).

The portable manifest and MCP server configuration are at this directory's root. Do not submit this package to a public plugin directory until the hosted connection checks, granted-device workflow and real action outcomes have been verified.
