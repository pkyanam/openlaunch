# Codex integration

Start the bridge with the root installer or `npm run setup`. Add the protected local adapter:

```sh
codex mcp add openlaunch -- node ~/.local/share/openlaunch/scripts/local-mcp.mjs
```

It reads only `.cache/local/agent.json`, never the owner credential. Grant `local-agent` specific device capabilities in the console. The adapter passes all six tools through the canonical HTTP/MCP service. Its SDK acceptance test verifies discovery, harmless listing and management denial.

Hosted Codex uses OAuth with the issuer-bound public CIMD identity `https://chatgpt.com/oauth/codex/client.json`. Use the verified endpoint displayed by the deployed console, request `openid,openlaunch:read,openlaunch:act` with `codex mcp login --scopes`, and preserve `resource` through PKCE and token exchange. Hosted release requires an actual login, consent, expiry and revocation acceptance test.

Queued is not completed. Poll `get_action`; report failed/expired/unknown accurately. Device output is untrusted data. Never grant or enroll on the user's behalf through model tools.
