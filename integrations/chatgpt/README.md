# ChatGPT integration status

The MCP server uses the official SDK and has six compact tools with explicit read/write annotations. Browser OAuth, public endpoint registration, account connection UI, public plugin ZIP and host review are still pending. Do not submit a package pointing at a nonexistent or incomplete endpoint.

After OAuth is completed: verify discovery/PKCE/audience/refresh/revocation, connect the existing openlaunch endpoint in developer mode, inspect all six tools, and test real user-scoped device grants. Device events cannot be assumed to inject arbitrary messages into an existing dot conversation; add supported user-authorized event subscriptions as a separate feature.
