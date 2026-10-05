# openlaunch

Let agents use the functions you approve on your hardware. openlaunch connects devices to an authenticated API and MCP server, then tracks each command through its result.

[Console](https://www.openlaunch.dev/console/) · [Documentation](https://www.openlaunch.dev/docs/setup) · [Downloads](https://www.openlaunch.dev/docs/resources) · [Source](https://github.com/pkyanam/openlaunch)

## Get started

1. Open the console and sign in with Google.
2. Choose **Devices → Add device** and create a device setup token.
3. On the computer connected to your board, or on your Pi, run:

   ```sh
   curl -fsSL https://www.openlaunch.dev/setup.sh | bash
   ```

   Choose Uno, ArduRoomba, Pi, ESP32, a custom adapter, or a local developer console. The helper prompts for the settings it needs. You need curl and Python 3; custom Node adapters and local development also need Node 24+. USB setup configures firmware you have already flashed.

4. Connect your agent in **Connections**, then open **Devices → your device → Access**. Choose that connection, select its functions, and **Save grant**.
5. Ask the agent to list devices and functions. When it invokes a function, check the action's final status and result.

You can [inspect the setup script](https://www.openlaunch.dev/setup.sh) before running it. It fetches the current hosted download manifest and checks the selected helper or SDK against its SHA-256. You do not need to copy a workspace ID, put a credential in a command, or install this repository to pair an already-flashed board.

## Connect ChatGPT, Codex, Executor, or your own app

The authenticated MCP URL is:

```text
https://www.openlaunch.dev/mcp
```

Use **Connections** for MCP instructions, OAuth client registration, or a separate agent API token. For Executor or your own OAuth app:

1. Open **Connections → OAuth clients**. Enter the app's exact callback URL, or choose **Use Executor settings**.
2. Choose **Read and invoke granted functions** if it needs device control. Register the client and copy its client ID and, for a confidential client, its one-time secret into the app.
3. Finish OAuth sign-in in the app. Under the device's **Access** view, grant functions to the registered connection.

**ChatGPT through Executor uses Executor's grant.** A direct ChatGPT grant does not authorize Executor. An online board can appear as an empty device list to an agent with no saved grant. Read-only connections cannot issue commands.

The stable MCP tools include `list_devices`, `list_functions`, `invoke_device_function`, health, LED/text helpers, and action status/cancellation. Granted functions also appear as device-specific tools. The generic invocation tool handles custom functions when a host caches an older tool list. See [agent setup](https://www.openlaunch.dev/docs/agents) and the [API reference](https://www.openlaunch.dev/docs/api).

## Hardware

| Device                 | What the maintained adapter implements                                              | Setup requirements                                                |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Uno R4 WiFi            | Health, built-in LED, matrix text                                                   | Matching RA sketch already flashed; Arduino CLI for USB detection |
| Uno + ArduRoomba       | Model 551 cleaning, docking, pause/stop, bounded movement, sensors, LEDs and sounds | Roomba sketch already flashed; Serial1 D0/D1, BRC D5, VIN/GND     |
| Raspberry Pi 4 Model B | Process health                                                                      | ARM64 or ARMv7 Linux; installer verifies the binary checksum      |
| Standalone ESP32       | Portable embedded SDK and health example                                            | Firmware already flashed; confirmed USB port                      |
| Custom Node adapter    | Functions you implement and publish                                                 | Node 24+ and your hardware library                                |

For Uno firmware builds from a checkout, install Arduino CLI and run:

```sh
npm run setup:firmware
```

The interactive helper asks for the application and transport, installs pinned dependencies in isolated library storage, and compiles. It never flashes either chip. Choose **console-mux** only when the matching custom ESP firmware is already installed. Its private repair directory stays local; the ESP image is never copied or published. Follow the [profile guide](docs/UNO-R4-PROFILES.md) for deliberate RA upload.

After flashing, the hosted setup menu pairs the board. From a checkout, the short equivalents are `npm run provision:uno` and `npm run provision:roomba`.

A compile, an online indicator, or a successful health result does not verify physical operation. Roomba operation remains unverified; the owner must flash the prepared application and test the actual robot. See [verification status](https://www.openlaunch.dev/docs/status).

## Credentials and permissions

- **Device setup token (`ol_sdk_`)**: pairs hardware only. Short-lived, one device by default. The board receives its own private credential; it does not keep the setup token.
- **Agent OAuth or API token (`ol_agent_`)**: authenticates an agent, with a read/action ceiling. Cannot pair devices.
- **Function grant**: owner approval for a particular connection, device, and set of functions. Can expire or remain until revoked. OAuth sign-in does not create it.

Revoking a connection removes its grants. Revoking a setup token does not disconnect a device already paired; removing the device revokes its private credential. A changed device manifest requires new function approval.

Actions have expiry and idempotency checks. Check terminal results before reporting success; a lost connection can leave a physical outcome unknown. Provider credentials stay off firmware. Keep tokens, Wi-Fi passwords and private repair assets outside Git.

## Downloads stay in sync

GitHub CI builds the website, console, helpers, SDK archives and Pi binaries from one commit. After checks pass, it deploys that set together to openlaunch.dev. The hosted setup command reads the current manifest each time; you never need to edit a version or paste a long package URL.

[installers.json](https://www.openlaunch.dev/downloads/installers.json) records the source commit, hashes and commit-pinned GitHub backups. [deployment.json](https://www.openlaunch.dev/deployment.json) identifies the live website. A new local installation checks out that deployed GitHub commit. Existing local checkouts are preserved, so the installer cannot discard your edits. Downloads follow the checked deployment directly from GitHub source; they do not depend on a separately maintained release tag.

## Develop locally

With Node 24+ and Git, clone this repository and run:

```sh
npm run setup
```

This installs dependencies, builds the console, and starts the local bridge at `http://127.0.0.1:8788`. Paste the private owner session key into the console; on macOS it is copied to the clipboard. Press Ctrl-C to stop; `npm run start:local` starts it again. The local owner key is separate from agent credentials and must not be shared with an agent.

| Command                  | Purpose                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `npm run check`          | Type checks and software tests                                     |
| `npm run build`          | Website, console, bridge and Pi builds; requires Go                |
| `npm run setup:firmware` | Guided Uno dependency setup and compilation                        |
| `npm run test:e2e`       | Local HTTP/Go flow with simulated hardware; requires Go            |
| `npm run verify`         | Full checks including firmware; prepare Arduino dependencies first |

Platform and deployment details live in [Mac handoff](docs/MAC-HANDOFF.md), [architecture](docs/architecture.md), and [deployment](docs/WEBSITE-DEPLOYMENT.md).

## Repository layout

- `apps`: Blume site, owner console, Cloudflare bridge, local bridge
- `packages`: protocol, authorization, HTTP, MCP, device and agent SDKs
- `devices/pi` and `firmware/uno-r4-wifi`: maintained runtimes
- `scripts`: installers, setup helpers, builds and verification
- `integrations`: agent connection guides
