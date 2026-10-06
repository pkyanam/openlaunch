# openlaunch Agent Plugin package

The portable Agent Plugins 1.0 package for ChatGPT and Codex is in [`openlaunch/`](openlaunch/). Use that directory as the plugin root when installing or validating it. It connects to the canonical openlaunch device MCP at `https://www.openlaunch.dev/mcp`, the separate read-only docs MCP at `https://www.openlaunch.dev/docs-mcp`, and includes a skill for safe device-control workflows. Its icon and logo use the existing lowercase openlaunch artwork from the site.

The site build publishes a ready-to-download archive at [`https://www.openlaunch.dev/downloads/openlaunch-plugin.zip`](https://www.openlaunch.dev/downloads/openlaunch-plugin.zip). To create the same archive locally, run `node scripts/package-plugin.mjs` from the repository root; it writes `apps/site/dist/client/downloads/openlaunch-plugin.zip` and prints its SHA-256 checksum.

The OAuth connection and device permission are separate steps. After signing in and consenting to requested scopes, new agent connections cover all current and future workspace functions unless excluded. Owners manage exclusions in Connections → Agents; existing selected-function connections retain their grants. A queued action is only a receipt; use `get_action` to inspect the final device outcome. Custom function tools appear when the live access policy and credential scope permit them.

The hosted `/mcp` endpoint currently enforces OAuth. Hosted device controls are still deployment-gated; a reachable authenticated endpoint does not mean hardware control has been verified. See [ChatGPT integration status](../chatgpt/README.md) and [Codex setup](../codex/README.md).

Do not submit the package to a public plugin directory until the hosted connection checks, granted-device workflow and real action outcomes have been verified.
