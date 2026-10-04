# openlaunch

Connect agents to your hardware. openlaunch provides a shared API, MCP server and SDKs for devices and agents, with owner-approved functions and visible action results.

[Website](https://www.openlaunch.dev) · [Console](https://www.openlaunch.dev/console/) · [Documentation](https://www.openlaunch.dev/docs) · [Downloads](https://www.openlaunch.dev/docs/resources)

## Connect a device

Sign in with Google, create an SDK token in **Connections**, and choose **Add device**. Device and agent libraries accept the same token. The device keeps its own private credential after pairing; an agent still needs your approval for each device's functions.

On Raspberry Pi OS:

```sh
curl -fsSL https://www.openlaunch.dev/install-pi.sh | bash
```

For a custom Linux or desktop adapter:

```sh
npx --yes --package=https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz openlaunch-device setup --url https://www.openlaunch.dev
```

Both prompt for one SDK token. Follow the [Uno guide](https://www.openlaunch.dev/docs/uno-r4) for USB setup or the [SDK guide](https://www.openlaunch.dev/docs/sdk) for ESP32 and custom adapters. Native downloads and commit-pinned GitHub backups are built from the same sources.

## Build functions

Write handlers in your adapter and publish a manifest describing their inputs. Owners approve individual functions before linked agents discover and invoke them. Custom board kinds use the same API. Built-in Uno functions cover health, LED and matrix text; the maintained Pi runtime reports health. Physical board acceptance is tracked separately in [verification](https://www.openlaunch.dev/docs/status).

Actions have TTLs, idempotency keys and separate queued, received and terminal outcomes. Broadcasts report each device independently. Device output cannot grant permissions. See [architecture](docs/architecture.md) for trust and transport boundaries.

## Develop locally

```sh
npm run setup
```

This installs dependencies, builds the console and starts the loopback bridge. [Mac handoff](docs/MAC-HANDOFF.md) covers development credentials, tests, deployment and hardware acceptance.

`npm run check` checks TypeScript and software tests. `npm run build` builds website, console, cloud service and host/Pi binaries. `npm run test:e2e` checks the real local HTTP/Go/SQLite flow using simulated hardware. `npm run verify` additionally compiles firmware; install pinned Arduino dependencies first.

Stock and repaired console-mux Uno profiles remain isolated. Read [transport profiles](docs/UNO-R4-PROFILES.md) before building or uploading. Builds never flash either chip or distribute repair assets.

## Repository

- `apps/site`: Blume website, searchable guides, Markdown exports and documentation MCP
- `apps/web`: owner console
- `apps/cloud`, `apps/local`: hosted Cloudflare and local SQLite bridges
- `packages`: protocol, authorization, core, HTTP, MCP, JavaScript and embedded SDKs
- `devices/pi`, `firmware/uno-r4-wifi`: maintained device runtimes
- `integrations`: ChatGPT, Codex and portable plugin guidance

Keep credentials outside Git. Provider credentials stay off hardware. [Deployment](docs/WEBSITE-DEPLOYMENT.md) records infrastructure and domain configuration.
