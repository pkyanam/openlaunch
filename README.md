# openlaunch

Provider-neutral device capabilities for agents. Initial hardware: Arduino Uno R4 WiFi and Raspberry Pi 4 Model B. ChatGPT/Codex are the first integration targets; other harnesses and ESP32 boards are deferred.

**Developer alpha, not production-ready.** The local bridge and MCP lifecycle have been tested with simulated hardware. No live Cloudflare deployment, completed browser OAuth flow or physical-device validation is claimed.

## Implemented
- Single-use, expiring enrollment; hashed per-device credentials and revocation
- Owner-only capability grants; an agent cannot grant itself access
- Typed LED, text-display and health commands; idempotency, TTL, cancellation and explicit uncertain outcomes
- SQLite local persistence and a Cloudflare Durable Object storage adapter
- Six tools through the official MCP SDK / Streamable HTTP
- Developer console for enrollment, inventory, grants and action receipts
- Go Pi client with a persistent action journal and explicit simulator mode
- Uno R4 WiFi firmware for HTTPS polling, built-in LED, matrix text and health
- Unit, MCP/HTTP integration, Go and firmware compile checks

## Start here
See [Mac handoff](docs/MAC-HANDOFF.md) for installation, local end-to-end testing, Cloudflare setup, real-board testing and the remaining production gates.

    npm ci
    npm run check
    npm run build --workspace @openlaunch/web
    npm run build --workspace @openlaunch/cloud

The cloud workspace's scripts/env.sh uses staged local toolchains and should not be sourced on a Mac. Go client build and E2E instructions are in the handoff.

## Monorepo commands

`npm run doctor` checks tool availability. `npm run build` builds web/cloud and host/Pi binaries. `npm run verify` runs the software tests, firmware compilation and simulated end-to-end test. See the handoff for the secure HTTPS real-board test path and interactive Uno USB provisioning.

## Modules
protocol / core / authorization / http / mcp packages; cloud / local / web applications; Go Pi runtime; Arduino firmware; independent host integrations.

Keep real credentials outside Git. The cloud bridge does not run an LLM; clients bring an authorized agent. API scope, device grant and physical execution are separate trust boundaries.
