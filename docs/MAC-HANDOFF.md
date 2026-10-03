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

## Cloudflare: blocked in cloud workspace, finish locally
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
    arduino-cli lib install ArduinoJson@7.4.3 ArduinoHttpClient@0.6.2 ArduinoGraphics@1.1.5
    arduino-cli compile --fqbn arduino:renesas_uno:unor4wifi firmware/uno-r4-wifi/openlaunch

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
