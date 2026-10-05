# openlaunch Mac handoff

## State of the implementation

The hosted website, Google-only Clerk owner sign-in, Codex OAuth approval, device API and workspace persistence are verified. On deployed commit `6e317a0`, the then-current legacy combined SDK-token acceptance confirmed stable attachment retry after a deliberately lost response, no master token in device identity, no default grants, 403 for ungranted actions and self-grants, 429 at the attachment limit, owner health and custom `custom.echo` grants, and grant removal after a manifest change. Authenticated Node WebSocket wake hints then triggered HTTPS rechecks; software-fixture results were health in 601 ms and `custom.echo` in 508 ms. The Node, Go Pi and Uno runtimes have durable result journals. On deployed commit `873f82900d99125782e7e9347753e6ee675ee90e`, the public, commit-selected `npx` installer paired a software adapter. The official Codex client discovered its approved custom function over Clerk OAuth, invoked it, and followed the action to completion. The adapter verified the matching server receipt before acknowledging its durable journal entry. Both acceptance fixtures, SDK tokens and device identities were revoked and removed afterward. These are software checks only; physical Pi, Uno and Roomba operation remains unverified.

The native SQLite migration deployed on commit `c4f34da7e4569864e8d8a8320c006eaf4d981554`; owner refresh and full-history download preserved all saved receipts. Commit `bf90990f6c29fd1a5da5eb10a65b141afded0206` added shared byte admission and result reservations, passed 111 tests and all deployment CI jobs, and retained the same owner history after deployment. These checks do not substitute for physical board acceptance.

On release `0f61baf1db82d5008a9aa74f575f545df988dd76`, all required CI jobs and the new live deployment verifier passed. The verifier checks the exact website and bridge commit, configured hosted authentication, denied unauthenticated inventory access, apex redirect and all five hosted installer copies. Run `python3 scripts/verify-hosted.py` from the deployed checkout without credentials to repeat it. At that release, Pi, Uno, ESP32 and Node setup rejected legacy agent tokens before attachment; setup used an owner-issued `ol_sdk_` token. Existing legacy agent authentication remained supported.

The current source contract separates device setup from agent access: `ol_sdk_` is a short-lived, attach-only setup token (10-minute and one-device defaults); `ol_agent_` is an agent API credential with read or action access and no attachment permission. Existing untyped combined records remain compatible, but new integrations must not create them. A setup token's expiry or revocation does not revoke a child credential already issued to a paired device. Agent access still needs a separate device grant, which can be time-limited or remain active until revoked. This documents the source contract; the deployment and physical-hardware verification claims above remain tied to their stated commits and evidence.

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

The cloud storage check runs the built Worker in local workerd with disposable SQLite files, verifies device attachment, a runtime restart, idempotency, grants, outcomes, export and revocation, then removes its temporary directory. It uses test principals at the edge-to-object boundary; Clerk authentication has separate verification tests. It does not contact production or access hardware.

The E2E command generates disposable local fixture tokens internally, starts only on 127.0.0.1, runs the Go client, checks persistence/revocation, and removes its temporary test directory. It does not access real devices or external accounts.

## Manual local developer console

Set distinct random development-only OPENLAUNCH_OWNER_TOKEN and OPENLAUNCH_AGENT_TOKEN values in your terminal environment. The local server refuses missing/short/equal values; it never logs them. Do not reuse production credentials.

    npm run dev:local

Open http://127.0.0.1:8788. Enter the owner token in the development session field. Tokens remain only in page memory. In Devices → Add device, create a device setup token (`ol_sdk_`) to pair one device. Agent API credentials (`ol_agent_`) are created separately and cannot attach devices. Agent tools cannot issue enrollments or elevate grants; approve capabilities from the owner console. Default local agent principal is `local-agent`.

For a simulated Pi, pass its enrollment token through OPENLAUNCH_ENROLLMENT_TOKEN in the terminal environment, then run:

    ./dist/openlaunch-device-host --enroll --url http://127.0.0.1:8788 --config /tmp/openlaunch-device.json --simulate
    ./dist/openlaunch-device-host --config /tmp/openlaunch-device.json

Without --simulate the Pi advertises real process-health only. It does not pretend to control GPIO or a display without an installed adapter. Simulation results are explicitly labeled.

## MCP

Local endpoint: http://127.0.0.1:8788/mcp with Authorization: Bearer supplied from OPENLAUNCH_AGENT_TOKEN. Configure the host's supported environment-variable bearer-token setting; do not paste credentials into prompts or commit them to a plugin.

Stable tools include list_devices, list_functions, invoke_device_function, request_device_health, show_text, set_led, get_action and cancel_action. list_functions reads the current granted built-in and custom schemas; invoke_device_function calls any granted function even when a host retains its initial tool list. Granted functions also become device-specific MCP tools during discovery. Older connections need one tool refresh to pick up the two new stable tools. Jobs return queued/received before terminal status; a queued result is not success. Each device capability needs an owner-approved grant. Hosted ChatGPT and Codex connections use https://www.openlaunch.dev/mcp with Clerk OAuth. Localhost remains available for local developer testing.

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

Primary device setup uses an `ol_sdk_` token that includes its public workspace routing ID, so no separate workspace prompt is needed. The advanced legacy enrollment view still shows the bridge origin and workspace ID beside a one-time enrollment code. In local mode the workspace ID is 64 zeros; it is a development routing marker, not a credential. In hosted mode use the actual workspace ID returned by the server. Never copy the local marker to a hosted workspace.

### Uno R4 WiFi from macOS

1. Connect the Uno by USB. Run `arduino-cli board list` and confirm its board/port; close other serial monitors.
2. Compile with `npm run build:firmware`. Flash only the identified board:

       arduino-cli upload --fqbn arduino:renesas_uno:unor4wifi --port /dev/cu.YOUR_CONFIRMED_PORT --input-dir build/firmware/stock/compiled

   For the repaired board, explicitly build `console-mux` and use `build/firmware/console-mux/compiled` instead. The existing matching custom ESP bridge must remain installed. Upload is a separate owner action; build commands never flash.

3. Open the HTTPS console, select Devices → Add device, and create a device setup token. It expires after 10 minutes by default and permits one attachment by default. Copy its secret once.
4. Run the interactive helper. It prompts for Wi-Fi credentials and the device setup token with sensitive entries hidden, asks before sending, and does not write them to a file:

       npm run provision:uno -- --port /dev/cu.YOUR_CONFIRMED_PORT --origin https://YOUR_HTTPS_BRIDGE

5. Wait for the board's pairing confirmation. Refresh inventory, request health and confirm it comes back succeeded with the real board name/RSSI. Explicitly approve LED or text actions and observe the actual board. Then grant the local agent only the capabilities needed for the test.

If confirmation times out, inspect inventory before re-enrolling: the identity may already have been created. The helper intentionally withholds raw serial output and will not erase an existing identity. Wi-Fi credentials remain plaintext in device EEPROM; use an appropriate test network.

### Pi 4 from macOS

Use Raspberry Pi OS with working networking. In the hosted console choose Add device → Raspberry Pi, then paste its installer command on the Pi:

```sh
curl -fsSL https://www.openlaunch.dev/install-pi.sh | bash
```

The installer prompts for one `ol_sdk_` device setup token and derives the workspace automatically. It verifies the native binary checksum, saves only the returned device credential in a private config file, and retains a private request record for uncertain pairing retries. The device credential survives setup-token expiry or revocation; removing the device revokes it. The installer refuses to overwrite an existing identity. After an expired retry, inspect the portal inventory before starting another attachment.

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

## Device attachment credential keys

Production `DEVICE_CREDENTIAL_KEYS` is a deployment secret containing a JSON version-to-key map. Each key is independently generated 32-byte random hex. `DEVICE_CREDENTIAL_KEY_VERSION` selects the current version (default `v1`). Rotation adds a new version and retains old versions for outstanding 10-minute retries; never replace a key under an existing version. Existing device credentials continue to authenticate against their stored hashes. A missing or changed retry key fails closed. Local setup creates a private ignored keyring under `.cache/local/credential-keys.json`; preserve it when restarting the local bridge.

Device setup-token revocation and device revocation are separate: revoking a setup token blocks its future use but leaves an already paired board's private child credential active. Remove/revoke the device explicitly when retiring it. Agent API connection revocation stops that agent's requests and removes its grants. Uno storage migration recognizes the exact older EEPROM layout and verifies CRC/readback; unknown storage is preserved and blocks setup until an explicit owner reset.

## Serial-only Roomba correction

The Roomba sketch now defaults to Serial1/BRC wiring without D6/D7 controls. It retains local one-second wheel/brush deadlines, Safe mode, replay/result journals and separate grants. Optional owner-selected contact builds still support D6/D7. Sensor reads drain bounded startup text before querying; a timeout still requires restart. Health exposes the wiring policy and readiness without stopping autonomous cleaning. Source/compile validation is separate from installing the new RA sketch and observing the robot. Keep the repaired ESP image and console-mux transport intact; update only the RA application using the explicitly selected artifact.

## Custom OAuth clients and current MCP

Connections now includes an OAuth clients panel for Executor and custom hosts.
Owners register exact callbacks, choose public PKCE or confidential PKCE clients,
and set a read/action ceiling. Secrets are shown once and excluded from stored
records. Registration does not grant functions; choose the new client in a
device's Access view. Admission is workspace-specific, and revocation removes
grants and cancels undispatched commands even if provider cleanup fails.

Both hosted MCP endpoints and the local stdio adapter support 2026-07-28 and
legacy clients. See [MCP compatibility](MCP-COMPATIBILITY.md) for the supported
capabilities and official-schema checks. OAuth management, console registration,
copying, secret clearing, revocation and mobile layout were tested using
disposable software fixtures. No production client, token or grant was created
for this acceptance check, and no firmware was flashed. A live Executor OAuth
login and physical Roomba operation still require owner acceptance.

## Guided setup (October 5, 2026)

The current README and hosted setup menu are the user entry points. Run `curl -fsSL https://www.openlaunch.dev/setup.sh | bash` to choose an adapter; it reads the deployed checksum manifest and verifies the selected helper or SDK. USB modes provision already-flashed applications, not ESP firmware. From a checkout, `npm run setup:firmware` asks for stock or already-installed console-mux, confirms the mux pair, installs pinned isolated libraries, and compiles the selected RA application. It never uploads either chip. `npm run provision:roomba` pairs the Roomba sketch without a long command.

CI builds all hosted assets from the same GitHub commit. Fresh local installations check out the deployed commit; existing checkouts retain their files. There is no independently maintained release tag to drift from the downloads. Launcher acceptance covers hash/URL rejection, real USB helper help, the packaged adapter CLI offline, and a real terminal menu with piped stdin. The guided console-mux Roomba build passed locally with the matching custom ESP image hash unchanged. Compilation is not physical Roomba verification.

## API reference and installed CLI

The hosted installer `curl -fsSL https://www.openlaunch.dev/install-cli.sh | bash` installs the current checked SDK's `ol`, `openlaunch-agent` and `openlaunch-device` in the user's `~/.local/bin`, preserves shell configuration and configures PATH. Restart terminals/agents, then use `ol login` with a separate agent API credential. Login verifies read-only discovery and stores a private local credential; it creates no server tokens or grants. Environment tokens override saved login. Logout removes only the saved local credential; revoke the connection in the console for server revocation.

Blume 2.1.1 builds the native endpoint reference at `/docs/reference` from `/device-api.json`. Shared HTTP validators preserve request limits and defaults; published schemas document owner, agent, setup and device credentials separately. `/openapi.json` remains Blume's separate public documentation JSON API contract. Generated reference pages participate in search, Markdown, llms files and documentation MCP, including SDK and ol examples. See [Blume category coverage](BLUME-COVERAGE.md) for every feature area's implementation or decision. These additions do not flash hardware or change the repaired ESP assets.

### Live Executor scope acceptance

Read-only checks through Executor itself on October 5 confirmed that its current account sees the online Uno. The registered Executor client and saved grant permit all 13 functions, but that account exposes only `device.health` and `roomba.sensor.read`. Its generated `provider.ts` uses OAuth discovery without explicit scopes. Executor prioritizes the initial Bearer challenge's read scope over the resource's supported scopes. Configure `openlaunch:read`, `openlaunch:act` and optional `offline_access`, complete a new sign-in, and select the resulting account. Provider definition changes may change account compatibility; do not silently replace a user's selected account. Refreshing the current token does not escalate scope. No Executor app, account or authorization was changed during this check, and no physical command was sent.

## Linux host harness (October 5, 2026)

The native Go runtime now has a separate `linux` profile with up to 15 structured host functions, private local policy and cloud per-function grants. Use the new **Linux host** console choice or `curl -fsSL https://www.openlaunch.dev/install-linux.sh | bash`; then `openlaunch-host start` or `openlaunch-host service install`. The standalone ARM64, ARMv7 and x86-64 binaries and checksums are built with the website. The Pi health profile remains compatible.

See [Linux harness architecture and Muse comparison](LINUX-HARNESS.md) and the [public guide](../apps/site/docs/linux.mdx) for policy commands, roots, fixed argv, user services, file chunk limits and the trust boundary. Changing local policy requires runtime restart and new cloud grants. The default policy enables only a dedicated file workspace; commands and services need explicit local configuration. The runtime refuses root execution and provides no default unrestricted shell or LAN forwarding.

Local acceptance passed 170 software tests, Go race checks, real filesystem/subprocess tests, installer/PATH checks, the existing simulated Pi HTTP round trip and workerd SQLite persistence checks. Blume built 59 pages with 4,661 audits, zero errors/warnings, and the existing short-changelog note. Linux CI runs the actual host-profile API/MCP/CLI round trip with disposable local credentials, full-size file chunks, manifest reapproval and revocation. This does not verify a physical Pi or target systemd user services. Run `npm run test:linux` on Linux for that software flow, then perform the target hardware checklist separately. No Uno application or ESP repair asset changed, and neither chip was flashed.
