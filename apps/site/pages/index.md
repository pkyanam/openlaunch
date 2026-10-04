# openlaunch

Connect your agents to your hardware. openlaunch is an open source bridge for ChatGPT, Codex, and other agents. Pair a board, choose the capabilities an agent may use, and inspect each action's result.

## Get started

Install Node 24+ and Git, then run:

```sh
curl -fsSL https://raw.githubusercontent.com/pkyanam/openlaunch/main/scripts/install.sh | bash
```

[Setup guide](/docs/setup) · [Source](https://github.com/pkyanam/openlaunch) · [Downloads and resources](/docs/resources)

## Hardware

- [Uno R4 WiFi](/docs/uno-r4): health, built-in LED, and ASCII matrix text. Stock and repaired console-mux builds are isolated.
- [Raspberry Pi 4 Model B, 4GB or 8GB](/docs/pi): health through the Go agent.

Enrollment is single-use and expires after 10 minutes. Pairing registers your board; a separate capability grant lets an agent use it. Devices poll every 10 seconds. A queued action has not completed: inspect its final result.

## Build and learn

[Architecture](/docs/architecture) · [Permissions](/docs/pairing) · [Agent connections](/docs/agents) · [Verification](/docs/status) · [Upstream SDKs, OS images and tools](/docs/resources)

Each documentation page has a Markdown download. Search, browser narration, PDF and EPUB export are available in the docs. The read-only documentation MCP endpoint is `/docs-mcp`; it cannot control devices.
