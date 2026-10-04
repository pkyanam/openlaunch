# openlaunch Mac handoff

## State of the implementation

The hosted website, Google-only Clerk owner sign-in, Codex OAuth approval, device API and workspace persistence are verified. On deployed commit `6e317a0`, SDK acceptance confirmed stable attachment retry after a deliberately lost response, no master token in device identity, no default grants, 403 for ungranted actions and self-grants, 429 at the attachment limit, owner health and custom `custom.echo` grants, and grant removal after a manifest change. Authenticated Node WebSocket wake hints then triggered HTTPS rechecks; software-fixture results were health in 601 ms and `custom.echo` in 508 ms. The Node, Go Pi and Uno runtimes have durable result journals. On deployed commit `873f82900d99125782e7e9347753e6ee675ee90e`, the public, commit-selected `npx` installer paired a software adapter. The official Codex client discovered its approved custom function over Clerk OAuth, invoked it, and followed the action to completion. The adapter verified the matching server receipt before acknowledging its durable journal entry. Both acceptance fixtures, SDK tokens and device identities were revoked and removed afterward. These are software checks only; physical Pi, Uno and Roomba operation remains unverified.

The native SQLite migration deployed on commit `c4f34da7e4569864e8d8a8320c006eaf4d981554`; owner refresh and full-history download preserved all saved receipts. Commit `bf90990f6c29fd1a5da5eb10a65b141afded0206` added shared byte admission and result reservations, passed 111 tests and all deployment CI jobs, and retained the same owner history after deployment. These checks do not substitute for physical board acceptance.

## Install/build

Use Node 24+, Go 1.27.1 and Arduino CLI 1.5.1. No Docker is needed. Do not source scripts/env.sh on your Mac: it is the cloud staging wrapper.

    npm ci
    npm run check
    npm run build --workspace @openlaunch/web
    npm run build --workspace @openlaunch/cloud
    npm run test:cloud-storage
    cd devices/pi
    go test ./...
    go build -o ../../dist/openlaunch-device-host ./cmd/openlaunch-device
    cd ../..
    node scripts/e2e.mjs

The cloud storage check runs the built Worker in local workerd with disposable SQLite files, verifies SDK attachment, a runtime restart, idempotency, grants, outcomes, export and revocation, then removes its temporary directory. It uses test principals at the edge-to-object boundary; Clerk authentication has separate verification tests. It does not contact production or access hardware.

The E2E command generates disposable local fixture tokens internally, starts only on 127.0.0.1, runs the Go client, checks persistence/revocation, and removes its temporary test directory. It does not access real devices or external accounts.

## Manual local developer console

Set distinct random development-only OPENLAUNCH_OWNER_TOKEN and OPENLAUNCH_AGENT_TOKEN values in your terminal environment. The local server refuses missing/short/equal values; it never logs them. Do not reuse production credentials.

    npm run dev:local

Open http://127.0.0.1:8788. Enter the owner token in the development session field. Tokens remain only in page memory. Create an SDK token with device attachment enabled in Connections, then use Add device to choose an adapter. Agent tools cannot issue enrollments or elevate grants; approve capabilities from the owner console. Default local agent principal is `local-agent`.

For a simulated Pi, pass its enrollment token through OPENLAUNCH_ENROLLMENT_TOKEN in the terminal environment, then run:

    ./dist/openlaunch-device-host --enroll --url http://127.0.0.1:8788 --config /tmp/openlaunch-device.json --simulate
    ./dist/openlaunch-device-host --config /tmp/openlaunch-device.json

Without --simulate the Pi advertises real process-health only. It does not pretend to control GPIO or a display without an installed adapter. Simulation results are explicitly labeled.

## MCP

Local endpoint: http://127.0.0.1:8788/mcp with Authorization: Bearer supplied from OPENLAUNCH_AGENT_TOKEN. Configure the host's supported environment-variable bearer-token setting; do not paste credentials into prompts or commit them to a plugin.

Built-in tools include list_devices, request_device_health, show_text, set_led, get_action and cancel_action. Granted custom functions also become device-specific MCP tools. Jobs return queued/received before terminal status; a queued result is not success. Each device capability needs an owner-approved grant. Hosted ChatGPT and Codex connections use https://www.openlaunch.dev/mcp with Clerk OAuth. Localhost remains available for local developer testing.

## Hosted deployment

The live website, DNS routing, hosted device service, authentication status, deployment checks and approved budget are documented in [current website deployment](WEBSITE-DEPLOYMENT.md). The apex `openlaunch.dev` redirects to `www.openlaunch.dev`. The native `/install-pi.sh` installer, ARM64/ARMv7 binaries, SDK and plugin downloads are live and tied to the deployment commit. The approved Cloudflare spending ceiling is $10/month. Cloud credits remain unverified.

Google Clerk owner sign-in and real Codex OAuth approval have been exercised. `OPENLAUNCH_CONTROLS_ENABLED` is true after authenticated software device-flow tests passed. OAuth approval does not grant device capabilities; the owner must separately grant capabilities. No physical Pi or Uno R4 acceptance has been verified.

## Uno R4 WiFi

    arduino-cli core update-index
    arduino-cli core install arduino:renesas_uno@1.6.0
    npm run prepare:firmware

The prepare command validates and stages stock transport sources and writes the isolated configuration without compiling or downloading. Install the pinned dependencies in that configuration, then build:

    arduino-cli --config-file build/firmware/stock/arduino-cli.json lib update-index
    arduino-cli --config-file build/firmware/stock/arduino-cli.json lib install ArduinoJson@7.4.3 ArduinoHttpClient@0.6.2 ArduinoGraphics@1.1.5
    npm run build:firmware

The default `stock` profile stages stock WiFiS3 from the pinned core. It excludes the global sketchbook and Arduino environment overrides, and checks the compiler's resolved WiFiS3 path. Dependencies live under ignored `build/arduino-dependencies`; builds never install or replace global libraries. Do not use a raw `arduino-cli compile` on a Mac with a patched global WiFiS3. See [transport profiles](UNO-R4-PROFILES.md) for the repaired board.

Upload only after identifying the actual connected board/port. Firmware requires an HTTPS bridge, verified TLS and a valid clock before acting. Provision through USB serial JSON at 115200 using the documented fields in the sketch. Do not commit Wi-Fi passwords, enrollment tokens or device credentials. EEPROM storage is plaintext; physical access can expose credentials. Only built-in LED, ASCII text matrix and health are implemented. No arbitrary pin control. No OTA updates are implemented.

## Remaining acceptance work

- Test OAuth refresh/revocation and reviewer access without inbox dependence
- Profile large-workspace heap usage and request cost before raising the 16 MiB logical quota; review account-level abuse protection, usage metering and history archiving. Owner history export, shared admission checks and pending-result reservations are implemented; authenticated Node event hints retain a 10-second HTTPS polling fallback
- Test actual Pi/R4 Wi-Fi, TLS, time sync, USB provisioning, power loss and reconnect
- Review bounded streaming response parsing before expanding Uno beyond its built-in functions
- Implement firmware signing/update/rollback; public installers and SDK archives already pass checksum and packaging checks
- Expand accessibility and cross-browser coverage beyond the exercised owner sign-in, device setup, grants, revocation and responsive console flows

Never weaken TLS, token validation or authorization to get a demo through. No physical action is represented as exactly-once.

## Unified monorepo commands

Run from the repository root after `npm ci`:

    npm run doctor
    npm run build
    npm run test:device
    npm run test:e2e
    npm run prepare:firmware
    npm run build:firmware
    npm run verify

`build` builds both JS applications and native Go/ARM64/ARMv7 device binaries. `verify` additionally checks TypeScript, Node/Python/Go tests, the firmware compile and simulated E2E. `doctor` reports missing tools; it does not install packages, log in or read credentials. Install the pinned Arduino prerequisites listed above before firmware/verify.

## Secure real-board test connection

The local server remains bound to 127.0.0.1. A board cannot connect to your Mac's loopback address. Supply a trusted HTTPS reverse proxy/tunnel that you control, then start the server with `OPENLAUNCH_PUBLIC_ORIGIN` set to that exact HTTPS origin. Use disposable development owner/agent tokens, never production tokens. This explicitly exposes the development API at that origin, so only enable it for the test window and shut down the proxy afterward.

The proxy must target http://127.0.0.1:8788 and preserve either the configured public Host or 127.0.0.1:8788. Forwarded headers are not trusted. Open the console through the public HTTPS origin; using the loopback console with public-origin mode enabled will be rejected by origin validation. The origin must be bare (no path/query/credentials).

No tunnel is provisioned automatically. Configuring a public route is an explicit owner setup step. R4 needs a publicly trusted certificate on port 443; do not bypass certificate validation. An expired certificate, missing board CA support or unavailable clock is a blocker to fix, not an excuse to turn verification off.

Primary setup uses an SDK token that includes its public workspace routing ID, so no separate workspace prompt is needed. The advanced legacy enrollment view still shows the bridge origin and workspace ID beside a one-time enrollment code. In local mode the workspace ID is 64 zeros; it is a development routing marker, not a credential. In hosted mode use the actual workspace ID returned by the server. Never copy the local marker to a hosted workspace.

### Uno R4 WiFi from macOS

1. Connect the Uno by USB. Run `arduino-cli board list` and confirm its board/port; close other serial monitors.
2. Compile with `npm run build:firmware`. Flash only the identified board:

       arduino-cli upload --fqbn arduino:renesas_uno:unor4wifi --port /dev/cu.YOUR_CONFIRMED_PORT --input-dir build/firmware/stock/compiled

   For the repaired board, explicitly build `console-mux` and use `build/firmware/console-mux/compiled` instead. The existing matching custom ESP bridge must remain installed. Upload is a separate owner action; build commands never flash.

3. Open the HTTPS console, select Devices → Add device, and create or select an SDK token with an available attachment slot. Copy its secret once.
4. Run the interactive helper. It prompts for Wi-Fi credentials and SDK token with sensitive entries hidden, asks before sending, and does not write them to a file:

       npm run provision:uno -- --port /dev/cu.YOUR_CONFIRMED_PORT --origin https://YOUR_HTTPS_BRIDGE

5. Wait for the board's pairing confirmation. Refresh inventory, request health and confirm it comes back succeeded with the real board name/RSSI. Explicitly approve LED or text actions and observe the actual board. Then grant the local agent only the capabilities needed for the test.

If confirmation times out, inspect inventory before re-enrolling: the identity may already have been created. The helper intentionally withholds raw serial output and will not erase an existing identity. Wi-Fi credentials remain plaintext in device EEPROM; use an appropriate test network.

### Pi 4 from macOS

Use Raspberry Pi OS with working networking. In the hosted console choose Add device → Raspberry Pi, then paste its installer command on the Pi:

```sh
curl -fsSL https://www.openlaunch.dev/install-pi.sh | bash
```

The installer prompts for one SDK token and derives the workspace automatically. It verifies the native binary checksum, saves only the returned device credential in a private config file, and retains a private request record for uncertain pairing retries. It refuses to overwrite an existing identity. After an expired retry, inspect the portal inventory before starting another attachment.

The maintained runtime exposes process health. To control GPIO or peripherals, implement and advertise handlers through a custom adapter; a manifest alone cannot make hardware functions work. Do not pass `--simulate` during physical acceptance. An optional hardened systemd unit is provided at `devices/pi/openlaunch-device.service`; installation requires an unprivileged user and the actual binary/config paths.

### Hardware acceptance checklist

- Pair Pi and R4 separately; check distinct identities and the right board capabilities
- Confirm real health returns, R4 LED changes and matrix text physically appears
- Confirm an agent sees no device without a grant; grant only intended capabilities
- Revoke the grant and confirm subsequent commands are rejected
- Queue with board offline; wait past TTL and confirm it never executes after reconnect
- Restart bridge and boards; check identity/persistence, avoiding duplicate physical execution claims
- Revoke device identity and confirm it can no longer poll or execute
- Never count queued, simulated, or uncertain receipts as real hardware success

Hosted owner sign-in, Codex OAuth approval and authenticated software pairing/action flows are verified; controls are enabled. The above path makes real-board testing possible; physical acceptance remains unverified.

## SDK attachment credential keys

Production `DEVICE_CREDENTIAL_KEYS` is a deployment secret containing a JSON version-to-key map. Each key is independently generated 32-byte random hex. `DEVICE_CREDENTIAL_KEY_VERSION` selects the current version (default `v1`). Rotation adds a new version and retains old versions for outstanding 10-minute retries; never replace a key under an existing version. Existing device credentials continue to authenticate against their stored hashes. A missing or changed retry key fails closed. Local setup creates a private ignored keyring under `.cache/local/credential-keys.json`; preserve it when restarting the local bridge.

SDK token revocation and device revocation are separate: revoke a token to stop its agent requests and future attachments, then revoke a device explicitly when retiring it. A paired board keeps only its private child credential. Uno storage migration recognizes the exact older EEPROM layout and verifies CRC/readback; unknown storage is preserved and blocks setup until an explicit owner reset.
