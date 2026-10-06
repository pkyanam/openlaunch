# openlaunch

Let agents use the functions you approve on your hardware. openlaunch connects devices to an authenticated API and MCP server, then tracks each command through its result.

[Console](https://www.openlaunch.dev/console/) · [Documentation](https://www.openlaunch.dev/docs/setup) · [Downloads](https://www.openlaunch.dev/docs/resources) · [Source](https://github.com/pkyanam/openlaunch)

## Home Assistant

Connect HA devices, helpers, scripts, scenes and native services through one local gateway. In the console choose **Add device → Home Assistant**. On Home Assistant OS, install the **openlaunch** app from this repository and enter its setup token; HA authentication is automatic. For Home Assistant Container or a separate computer:

```sh
curl -fsSL https://www.openlaunch.dev/setup.sh | bash -s -- home-assistant
```

Grant your ChatGPT connection access to the current linked entities in the gateway's **Access** tab, then connect it to `https://www.openlaunch.dev/mcp`. Installation does not grant control. An empty HA installation can test real on/off calls with a Toggle helper. Updates keep pairing and local credentials. [Full setup guide](https://www.openlaunch.dev/docs/home-assistant).

## Get started

1. Open the console and sign in with Google or AgentID.
2. Choose **Devices → Add device** and create a device setup token.
3. On the computer connected to your board, or on your Linux device, run:

   ```sh
   curl -fsSL https://www.openlaunch.dev/setup.sh | bash
   ```

   Choose Uno, ArduRoomba, Pi, Linux host, ESP32, a custom adapter, or a local developer console. The helper prompts for the settings it needs. You need curl and Python 3; custom Node adapters and local development also need Node 24+. USB setup configures firmware you have already flashed.

4. Connect your agent in **Connections**, then open **Devices → your device → Access**. Choose that connection, select its functions, and **Save grant**.
5. Ask the agent to list devices and functions. When it invokes a function, check the action's final status and result.

You can [inspect the setup script](https://www.openlaunch.dev/setup.sh) before running it. It fetches the current hosted download manifest and checks the selected helper or SDK against its SHA-256. You do not need to copy a workspace ID, put a credential in a command, or install this repository to pair an already-flashed board.

## Connect ChatGPT, Codex, Executor, or your own app

**AgentID sign-in** lets an agent use its own verified identity through Clerk. A different Clerk account has a separate workspace; AgentID does not automatically link the agent to its human owner's devices. To access an existing workspace through MCP, API or `ol`, use that workspace's OAuth authorization or owner-issued agent API connection and approve its device functions. [AgentID setup and verification](docs/AGENTID.md).

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

## API, MCP and ol CLI

All three surfaces use the same live function schemas, authorization and action receipts. The [end-to-end API guide](https://www.openlaunch.dev/docs/api) explains the workflow; the [endpoint reference](https://www.openlaunch.dev/docs/reference) includes request/response schemas, errors and executable examples. Download [the canonical OpenAPI contract](https://www.openlaunch.dev/openapi.json) for your own integration; `/device-api.json` remains equivalent.

The [integration declaration](https://www.openlaunch.dev/.well-known/integrations.json) inventories the device API, MCP, `ol` and the separate public documentation services for [integrations.sh](https://integrations.sh/www.openlaunch.dev/). Machine-readable API catalogs, OAuth metadata and [agent skills](https://www.openlaunch.dev/.well-known/agent-skills/index.json) come from the same site build. See [publishing and verification](docs/INTEGRATIONS-PUBLISHING.md) for maintenance.

Install the Node CLI on macOS or Linux with Node 24+, npm, curl and Python 3:

```sh
curl -fsSL https://www.openlaunch.dev/install-cli.sh | bash
```

The installer verifies the current SDK checksum, installs `ol` in `~/.local/bin` and configures your shell PATH. Open a new terminal and restart your agent app, then run:

```sh
ol login
ol devices list
ol functions list
```

`ol login` privately prompts for a separate agent API credential from Connections. Grant that API connection functions in device Access. The credential stays in a private local file; setup tokens and owner sessions cannot log in. `ol call DEVICE_ID FUNCTION` queues an approved action, and `ol actions watch ACTION_ID` follows its result. See the [CLI guide](https://www.openlaunch.dev/docs/cli) for JSON arguments, retries, cancellation and logout.

## Hardware

| Device                 | What the maintained adapter implements                                              | Setup requirements                                                |
| ---------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Uno R4 WiFi            | Health, built-in LED, matrix text                                                   | Matching RA sketch already flashed; Arduino CLI for USB detection |
| Uno + ArduRoomba       | Model 551 cleaning, docking, pause/stop, bounded movement, sensors, LEDs and sounds | Roomba sketch already flashed; Serial1 D0/D1, BRC D5, VIN/GND     |
| Raspberry Pi 4 Model B | Health profile, or opt-in Linux host controls                                       | ARM64 or ARMv7 Linux; installer verifies the binary checksum      |
| Linux host             | Files, metrics, commands, user services and optional desktop control                | ARM64/ARMv7/x86-64; normal user; Bash, curl and Python 3          |
| Standalone ESP32       | Portable embedded SDK and health example                                            | Firmware already flashed; confirmed USB port                      |
| Custom Node adapter    | Functions you implement and publish                                                 | Node 24+ and your hardware library                                |

For native Linux host control, choose **Linux host** in the console and run:

```sh
curl -fsSL https://www.openlaunch.dev/install-linux.sh | bash
```

Open a new terminal, then run `openlaunch-host start` or `openlaunch-host service install`. The default file workspace is isolated from private device state. Allow additional directories, fixed commands or user services with short local `openlaunch-host` commands, then grant those functions to agents in the console. Policy changes require reapproval. See the [Linux guide](https://www.openlaunch.dev/docs/linux) for the 22 available functions and limits, and [Muse comparison](docs/LINUX-HARNESS.md) for the baseline and differences.

To update, rerun the same installer. It preserves the device token, policy, journal and uploads without pairing again. Unchanged manifests retain their grants; new functions require reapproval. An active user service restarts automatically; stop a foreground runner with Ctrl-C first and start it again afterward. Native work notifications reduce delivery delay, with ten-second polling as a fallback. `system.info` includes model, memory and optional temperature. Agents should keep checking the same action receipt until it finishes.

For Uno firmware builds from a checkout, install Arduino CLI and run:

```sh
npm run setup:firmware
```

The interactive helper asks for the application and transport, installs pinned dependencies in isolated library storage, and compiles. It never flashes either chip. Choose **console-mux** only when the matching custom ESP firmware is already installed. Its private repair directory stays local; the ESP image is never copied or published. Follow the [profile guide](docs/UNO-R4-PROFILES.md) for deliberate RA upload.

After flashing, the hosted setup menu pairs the board. From a checkout, the short equivalents are `npm run provision:uno` and `npm run provision:roomba`.

A compile, an online indicator, or a successful health result does not verify physical operation. The owner confirmed a real Roomba cleaning start; docking, bounded manual movement and long-running reliability remain separate acceptance. See [verification status](https://www.openlaunch.dev/docs/status).

## Pi shell and desktop control

After installing the Linux host, run these in the Pi's desktop terminal:

```sh
sudo apt install grim wtype
openlaunch-host enable-control
```

Restart the runner and approve its new functions in the device's **Access** tab. Your agent can then run shell commands, launch a browser, see real screenshots, and use mouse/keyboard through MCP, API or `ol`. Controls use the Pi user's permissions and require its active desktop. X11 and shell-only setup are documented in [Linux control](https://www.openlaunch.dev/docs/linux). Re-running the installer updates the binary while preserving your paired identity and local policy.

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

## License and project stewardship

Existing first-party code is [MIT-licensed](LICENSE), copyright Belweave. Hosted
and self-hosted openlaunch share this public production repository. Belweave
maintains `main` for community functionality and the flagship hosted service.
See [contributing guidelines](CONTRIBUTING.md), the [DCO](DCO), and the
[name and branding policy](TRADEMARK.md). Hosted service use is governed by its
Terms and Privacy Policy. Future separately licensed enterprise additions are
planned, not included in the current stack.
