# openlaunch architecture

## Monorepo boundaries

- `apps/cloud`: hosted Cloudflare Worker, OAuth JWT verifier and per-workspace Durable Object storage adapter
- `apps/local`: persistent local developer bridge; loopback only, optional explicitly configured HTTPS reverse proxy
- `apps/site`: static Blume product website and searchable guides; no device controls or authentication endpoints
- `apps/web`: React owner console, shared by local development and future hosted onboarding
- `packages/protocol`: capability and manifest contracts
- `packages/core`: enrollment, device identities, capability grants, command lifecycle, expiry and revocation
- `packages/authorization`: shared authorization helpers
- `packages/http`: transport-neutral HTTP handlers
- `packages/mcp`: agent-facing tools through the official MCP SDK
- `devices/pi`: standalone Go module, Linux ARM64/ARMv7 runtime, optional systemd unit
- `firmware/uno-r4-wifi`: Arduino C++ firmware, pinned board core and libraries
- `integrations`: host-specific integration guidance, not firmware dependencies
- `scripts`: root build orchestration, simulated E2E and interactive USB provisioning

JavaScript packages use npm workspaces and one lockfile. Go and Arduino keep their native toolchains; root npm tasks orchestrate them. No provider-specific credentials go onto a board.

## Pairing and control

An owner creates a board-kind-bound, single-use enrollment token (10 minute lifetime). The device exchanges it for its own credential; only a hash is stored by the bridge. Enrollment associates the device with the workspace but grants no agent permission. The owner separately approves capabilities for an agent principal and device with a bounded lifetime.

An authenticated MCP request becomes a typed, bounded action. Both API scopes and per-device grants are checked. The board initiates outbound HTTPS polls, receives a command and reports a correlated result. Queued/received/terminal states are distinct. Disconnects and crashes can leave an unknown physical outcome; no exactly-once claim is made.

Cloudflare is a trusted relay. TLS protects each network hop, not end-to-end encryption from model host to hardware. R4 credentials are plaintext in EEPROM; Pi credentials live in a restricted local file. Physical compromise can expose them.

## Implemented vs planned

Implemented: local SQLite persistence, shared command/permission engine, stateless Streamable HTTP MCP, React developer console, Go simulated/health runtime, compiled R4 LED/matrix/health firmware, Cloudflare build scaffold and JWT verification.

Not yet implemented: hosted login/consent/refresh, dashboard secure sessions, public deployment/domain routing, WebSocket delivery, OTA signing/rollback, unattended account lifecycle and broad-scale quotas. Current devices poll every 10 seconds. D1 metadata and R2 artifacts are design options, not deployed dependencies.

Real Pi health works at the process level; physical GPIO/display adapters are not present. Simulated LED/display results are explicitly labeled. Real-board acceptance remains necessary.

## Two testing modes

1. Local software: console and simulated Go board on loopback, disposable development tokens, SQLite. No cloud account required.
2. Real boards: trusted HTTPS endpoint through an owner-configured reverse proxy to the local bridge, or a deployed authenticated bridge. R4 requires port 443 and a hostname trusted by its connectivity firmware. Never disable TLS checks or use HTTP over the LAN.

The reverse-proxy mode still uses development bearer authentication. It does not implement public ChatGPT OAuth. Prefer local Codex for this alpha, then complete hosted OAuth before general ChatGPT onboarding.
