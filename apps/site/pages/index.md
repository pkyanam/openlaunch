# openlaunch

Connect your agents to your hardware. openlaunch is an open source bridge for ChatGPT, Codex, and other agents. Pair a board, choose the capabilities an agent may use, and inspect each action's result.

## Get started

[Open your console](/console/) and sign in with Google. Create a device setup token in Add device and run the displayed setup command. Connect agents separately with OAuth or an agent API token, then choose the functions each agent may use. Access can remain active until revoked.

For a local development bridge, install Node 24+ and Git, then run:

```sh
curl -fsSL https://www.openlaunch.dev/install.sh | bash
```

[Setup guide](/docs/setup) · [Source](https://github.com/pkyanam/openlaunch) · [Downloads and resources](/docs/resources)

## Hardware

- [Uno R4 WiFi](/docs/uno-r4): health, built-in LED, and ASCII matrix text. Stock and repaired console-mux builds are isolated.
- [Raspberry Pi 4 Model B, 4GB or 8GB](/docs/pi): health through the Go agent.
- Any board can connect through the [device SDK](/docs/sdk) or its documented HTTP protocol. A custom adapter needs to implement the functions it advertises.

Device pairing creates a private device credential. The owner separately grants an agent specific functions on that device. Devices poll every 10 seconds. A queued action has not completed: inspect its final result.

## Build and learn

[Device and agent SDK](/docs/sdk) · [Permissions](/docs/pairing) · [Agent connections](/docs/agents) · [Verification](/docs/status) · [Upstream SDKs, OS images and tools](/docs/resources)

Each documentation page has a Markdown download. Search, browser narration, PDF and EPUB export are available in the docs. The read-only documentation MCP endpoint is `/docs-mcp`; it cannot control devices.

## Legal and contact

openlaunch is operated by Belweave. Read the [Terms of Service](/docs/terms) and [Privacy Policy](/docs/privacy). Contact [info@belweave.com](mailto:info@belweave.com).
