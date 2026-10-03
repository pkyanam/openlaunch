# Codex development integration

Use the remote Streamable HTTP /mcp endpoint once OAuth is implemented. For local testing, point Codex's supported HTTP MCP transport at http://127.0.0.1:8788/mcp and configure its bearer-token environment-variable option. Use OPENLAUNCH_AGENT_TOKEN, never the owner token. The owner console grants `local-agent` individual device capabilities.

Test tool discovery, read-only denial, display/LED execution and get_action acknowledgments. Missing tools are not evidence the account API lacks a feature. Do not automatically reset authentication or expose root/shell capabilities.
