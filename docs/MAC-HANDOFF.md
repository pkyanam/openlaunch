# openlaunch Mac handoff

## State of the implementation
This is a developer alpha, not a public service ready for launch. The local bridge, typed protocol, capability grants, action lifecycle, SQLite persistence and official-SDK MCP interface work with an actual Go client in simulated-hardware mode. Uno R4 firmware compiles. Real hardware and hosted OAuth are not verified.

## Install/build
Use Node 24+, Go 1.27.1 and Arduino CLI 1.5.1. No Docker is needed. Do not source scripts/env.sh on your Mac: it is the cloud staging wrapper.

    npm ci
    npm run check
    npm run build --workspace @openlaunch/web
    npm run build --workspace @openlaunch/cloud
    cd devices/pi
    go test ./...
    go build -o ../../dist/openlaunch-device-host ./cmd/openlaunch-device
    cd ../..
    node scripts/e2e.mjs

The E2E command generates disposable local fixture tokens internally, starts only on 127.0.0.1, runs the Go client, checks persistence/revocation, and removes its temporary test directory. It does not access real devices or external accounts.

## Manual local developer console
Set distinct random development-only OPENLAUNCH_OWNER_TOKEN and OPENLAUNCH_AGENT_TOKEN values in your terminal environment. The local server refuses missing/short/equal values; it never logs them. Do not reuse production credentials.

    npm run dev:local

Open http://127.0.0.1:8788. Enter the owner token in the development session field. Tokens remain only in page memory. Create an enrollment for the desired board. Agent tools cannot issue enrollments or elevate grants; approve capabilities from the owner console. Default local agent principal is `local-agent`.

For a simulated Pi, pass its enrollment token through OPENLAUNCH_ENROLLMENT_TOKEN in the terminal environment, then run:

    ./dist/openlaunch-device-host --enroll --url http://127.0.0.1:8788 --config /tmp/openlaunch-device.json --simulate
    ./dist/openlaunch-device-host --config /tmp/openlaunch-device.json

Without --simulate the Pi advertises real process-health only. It does not pretend to control GPIO or a display without an installed adapter. Simulation results are explicitly labeled.

## MCP
Local endpoint: http://127.0.0.1:8788/mcp with Authorization: Bearer supplied from OPENLAUNCH_AGENT_TOKEN. Configure the host's supported environment-variable bearer-token setting; do not paste credentials into prompts or commit them to a plugin.

Six tools: list_devices, request_device_health, show_text, set_led, get_action, cancel_action. Jobs return queued/received before terminal status; a queued result is not success. Each device capability needs an owner-approved grant. Real ChatGPT connection requires a public HTTPS endpoint and complete OAuth first; localhost is for local Codex/Inspector testing only.

## Cloudflare: original handoff and current website work

October 4 update: the Mac cf login now verifies the intended account. The owner authorized removal of the old Worker/Vercel website and obsolete Clerk DNS entries. New static website deployment is prepared, but Cloudflare Pages Git authorization needs repair. Credit eligibility remains unverified (billing API 403); owner approved up to $10/month and Vercel DNS with www first. See [current website deployment](WEBSITE-DEPLOYMENT.md) before acting on the historical instructions below. Hosted device authentication and real hardware acceptance are still unfinished.

### Original cloud workspace handoff
The cloud cf device-code exchange was blocked by network policy. Do not reuse old codes.

    npx cf auth login
    npx cf auth whoami
    npx cf zones list --name openlaunch.dev

Use preetham@belweave.com's intended account. Verify account/zone and credit eligibility, then choose an explicit spending budget before provisioning services. Pin the account in the project configuration. No Cloudflare resources or DNS records have been created by this implementation.

apps/cloud/cloudflare.config.ts builds a Worker plus SQLite-backed WorkspaceHub Durable Object. It does not configure the purchased domain. The API returns setup_required until AUTH_ISSUER, AUTH_JWKS_URL and API_ORIGIN are supplied by the deployed environment. It accepts properly signed RS256/ES256 tokens with issuer, subject, expiry, audience API_ORIGIN + /mcp and openlaunch:read scope. Device-action requests additionally need openlaunch:act and a per-device capability grant. The administrative openlaunch:owner scope MUST be restricted by the authorization server to owner dashboard sessions, never ordinary MCP clients.

IMPORTANT: OAuth authorization/login/consent/refresh endpoints are NOT implemented yet. Build the maintained Cloudflare OAuth provider integration and a real user-login provider, test it end to end, then connect ChatGPT. Do not point the verifier at an arbitrary provider and call OAuth complete. Device clients send x-openlaunch-workspace, obtained from an authenticated response. Public device authentication is per-device, not the workspace id.

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
- Complete/test browser OAuth, refresh/revocation and reviewer access without inbox dependence
- Replace prototype 10-second polling with tested hibernating WebSockets before broad scale; current polling can be costly and has latency
- Add edge rate limits, robust account-level enrollment abuse protection, quota metering, retention/export and durable event subscriptions
- Verify Cloudflare Durable Object persistence and tenant isolation on a real deployment
- Serve web dashboard on the deployment and replace manual token input with a secure user session
- Test actual Pi/R4 Wi-Fi, TLS, time sync, USB provisioning, power loss and reconnect
- Add R4 persistent executed-command journal and bounded streaming response parsing before expanding beyond idempotent built-in LED/display operations
- Add Pi result-retry journal reconciliation; current uncertain acknowledgments are reported but not silently replayed
- Implement firmware signing/update/rollback and installer packaging before public distribution
- Run browser accessibility/responsive/visual tests on the Mac; cloud UI only build-checked

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

## Secure real-board test connection before hosted OAuth

The local server remains bound to 127.0.0.1. A board cannot connect to your Mac's loopback address. Supply a trusted HTTPS reverse proxy/tunnel that you control, then start the server with `OPENLAUNCH_PUBLIC_ORIGIN` set to that exact HTTPS origin. Use disposable development owner/agent tokens, never production tokens. This explicitly exposes the development API at that origin, so only enable it for the test window and shut down the proxy afterward.

The proxy must target http://127.0.0.1:8788 and preserve either the configured public Host or 127.0.0.1:8788. Forwarded headers are not trusted. Open the console through the public HTTPS origin; using the loopback console with public-origin mode enabled will be rejected by origin validation. The origin must be bare (no path/query/credentials).

No tunnel is provisioned automatically. Configuring a public route is an explicit owner setup step. R4 needs a publicly trusted certificate on port 443; do not bypass certificate validation. An expired certificate, missing board CA support or unavailable clock is a blocker to fix, not an excuse to turn verification off.

The pairing console now shows the bridge origin and workspace ID beside the one-time enrollment token. In local mode the workspace ID is 64 zeros; it is a development routing marker, not a credential. In hosted mode use the actual workspace ID returned by the server. Never copy the local marker to a hosted workspace.

### Uno R4 WiFi from macOS

1. Connect the Uno by USB. Run `arduino-cli board list` and confirm its board/port; close other serial monitors.
2. Compile with `npm run build:firmware`. Flash only the identified board:

       arduino-cli upload --fqbn arduino:renesas_uno:unor4wifi --port /dev/cu.YOUR_CONFIRMED_PORT --input-dir build/firmware/stock/compiled

   For the repaired board, explicitly build `console-mux` and use `build/firmware/console-mux/compiled` instead. The existing matching custom ESP bridge must remain installed. Upload is a separate owner action; build commands never flash.

3. Open the HTTPS console and select Pair Uno R4. Copy the workspace ID.
4. Run the interactive helper. It prompts for Wi-Fi credentials and enrollment token with sensitive entries hidden, asks before sending, and does not write them to a file:

       npm run provision:uno -- --port /dev/cu.YOUR_CONFIRMED_PORT --origin https://YOUR_HTTPS_BRIDGE --workspace WORKSPACE_ID_FROM_CONSOLE

5. Wait for the board's pairing confirmation. Refresh inventory, request health and confirm it comes back succeeded with the real board name/RSSI. Explicitly approve LED or text actions and observe the actual board. Then grant the local agent only the capabilities needed for the test.

If confirmation times out, inspect inventory before re-enrolling: the identity may already have been created. The helper intentionally withholds raw serial output and will not erase an existing identity. Wi-Fi credentials remain plaintext in device EEPROM; use an appropriate test network.

### Pi 4 from macOS

Use Raspberry Pi OS, enable SSH through your chosen normal setup, and copy the appropriate artifact from `dist/` to the Pi (arm64 for 64-bit OS, arm for 32-bit OS). This repo does not enable SSH, configure networking, or flash an SD card for you.

On the Pi, set the one-time enrollment token in the process environment and run the binary with the HTTPS origin, workspace ID and an explicit config path outside your checkout:

    ./openlaunch-device --enroll --url https://YOUR_HTTPS_BRIDGE --workspace WORKSPACE_ID_FROM_CONSOLE --config "$HOME/.config/openlaunch/device.json"
    ./openlaunch-device --config "$HOME/.config/openlaunch/device.json"

Do not pass `--simulate` on real hardware acceptance. This implementation advertises health only on a real Pi; GPIO/display require future adapters. An optional hardened systemd unit is provided at `devices/pi/openlaunch-device.service`; installing it requires preparing its unprivileged user, binary and credential path. That installation is intentionally not automatic.

### Hardware acceptance checklist

- Pair Pi and R4 separately; check distinct identities and the right board capabilities
- Confirm real health returns, R4 LED changes and matrix text physically appears
- Confirm an agent sees no device without a grant; grant only intended capabilities
- Revoke the grant and confirm subsequent commands are rejected
- Queue with board offline; wait past TTL and confirm it never executes after reconnect
- Restart bridge and boards; check identity/persistence, avoiding duplicate physical execution claims
- Revoke device identity and confirm it can no longer poll or execute
- Never count queued, simulated, or uncertain receipts as real hardware success

Hosted OAuth and openlaunch.dev deployment remain separate acceptance gates. The above path makes real-board testing possible without pretending hosted onboarding is finished.
