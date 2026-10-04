# openlaunch architecture

## Monorepo boundaries

- `apps/cloud`: Cloudflare Worker for hosted API requests, Clerk identity checks and workspace-isolated SQLite Durable Object storage
- `apps/local`: persistent local developer bridge, bound to loopback by default
- `apps/site`: product website, searchable guides, Markdown downloads and read-only documentation MCP
- `apps/web`: React owner console for pairing, permissions and action inspection
- `packages/sdk`: typed agent/device clients and a custom adapter CLI; independent of board libraries and agent providers
- `packages/protocol`: capability, device manifest and request contracts
- `packages/core`: enrollment, device identities, grants, command lifecycle, expiry and revocation
- `packages/authorization`: shared authorization helpers
- `packages/http`: transport-neutral HTTP handlers
- `packages/mcp`: agent-facing tools using the official MCP SDK
- `devices/pi`: Go runtime for Linux ARM64/ARMv7
- `firmware/uno-r4-wifi`: Arduino C++ firmware with pinned board core and libraries
- `integrations`: host-specific integration guidance, independent of firmware
- `scripts`: build orchestration, simulated E2E flows and USB provisioning

JavaScript packages use npm workspaces and one lockfile. Go and Arduino keep their native toolchains; root npm tasks orchestrate them. Provider credentials stay off devices.

## Identity, pairing and permissions

Clerk provides hosted owner sign-in and agent OAuth. The hosted service verifies owner sessions and OAuth access tokens against the configured issuer. OAuth uses PKCE and resource audiences; admitted agent identities are configured explicitly. Google is the enabled sign-in provider, and email/password sign-in is disabled.

Owner sessions and agent identities are separate. An owner creates a named, expiring SDK token with an attachment limit. Device and agent SDKs accept the same token format. A device setup exchanges it for a private device credential; the SDK token is not kept in the final device identity. Legacy board-bound enrollment codes remain single-use and expire after 10 minutes. Enrollment associates the device with the owner's workspace, but does not grant an agent permission to use it. The owner separately grants an agent selected capabilities on that device for a bounded period. OAuth scopes allow API operations; they do not create device grants. Other applications use named, expiring owner-created SDK connections. Their secrets authenticate a connection and may attach devices up to the owner-selected limit; they never authenticate an owner and are stored as hashes. Attachment does not create a grant. Revoking the SDK token stops its agent access and future attachments; an already paired device remains paired until separately revoked. Read-only connections cannot issue commands.

The hosted service derives each workspace's SQLite Durable Object identity from the verified Clerk issuer and user identity. Requests are isolated by workspace. Agent requests are checked for their OAuth scope and a live per-device capability grant on each call, including calls made through previously discovered custom-function tools.

## Commands and device functions

An authorized MCP request becomes a typed, bounded action. Devices initiate outbound HTTPS polls, receive commands and report correlated results. Queued, received and terminal states are distinct. Expiry and revocation are enforced by the service. If a device disconnects or loses an acknowledgment, the physical outcome can remain unknown; the system does not promise exactly-once execution.

Devices may advertise functions in their manifest. Definitions include a name, title, description and input schema. Supported input fields are bounded strings, bounded numbers or integers, and booleans in a root object that rejects additional properties. Manifests are limited to 16 functions and 16 parameters per function, reject external schema references and cannot replace built-in capabilities. An owner can grant custom functions individually; approved functions appear as device-specific MCP tools and are checked against current grants when invoked.

The `POST /v1/broadcasts` endpoint can request the same action for up to 20 devices. It returns an independent action or error for every device, so a broadcast is not an atomic multi-device operation.

## Device SDK boundaries

The cloud service accepts bounded custom device kinds without a board-specific service change. A device adapter owns its hardware drivers, credential storage, manifest and execution. The shared protocol owns attachment, polling and correlated results. Attachments use a durable request UUID and manifest fingerprint; a lost response can recover the same identity within 10 minutes. The service derives the child credential with a versioned, server-only HMAC keyring, stores only its hash, and rejects expired or changed retries rather than creating another device. Agent integrations use the same API and grants; provider credentials never reach firmware.

Linux and desktop custom adapters can use the Node SDK and its setup/publish/run CLI. The maintained Go Pi adapter is a separate lightweight health runtime. Native microcontroller adapters speak the same HTTPS contract, using platform TLS and storage. Pi, Uno and standalone ESP32 setup accept the same SDK token. USB helpers prompt for credentials and configure runtime storage; secrets are not compiled into sketches. An ESP32 development board is not the Uno R4 connectivity coprocessor; support for one must not alter the other's transport firmware.

Manifest changes require owner reapproval. They revoke prior device grants, cancel queued commands and preserve uncertainty for commands already received. A schema describes implemented behavior; advertising a function cannot install a driver or make an unsupported board operation work.

## Trust boundaries and runtime support

Cloudflare is a trusted relay. TLS protects each network hop; it does not provide end-to-end encryption from the model host to the board. R4 credentials are stored in plaintext in EEPROM; Pi credentials use a restricted local file. Physical compromise can expose them. Commands are typed and bounded; unrestricted shell access and arbitrary LAN proxying are not default capabilities.

The Go Pi runtime reports process health. Its GPIO and display control adapters are not implemented. Uno R4 firmware supports health, the built-in LED and matrix text. Runtime acceptance on physical boards—including network, TLS, provisioning, power-loss and reconnect behavior—is still pending. Health and simulated results must not be represented as successful physical actions.

## Delivery and deployment

Devices poll over outbound HTTPS, currently every 10 seconds. The hosted bridge uses a Cloudflare Worker and one SQLite-backed Durable Object per workspace. The public documentation site is a separate Cloudflare Pages deployment; its `/docs-mcp` endpoint serves read-only documentation tools and does not control devices.

The public website is served at `www.openlaunch.dev`; the apex redirects to `www`. Vercel remains authoritative for DNS. The hosted service and website deployments are independent. See [website deployment](WEBSITE-DEPLOYMENT.md) for deployment and domain details.

WebSocket delivery, OTA signing and rollback, durable event subscriptions, broader quotas and account lifecycle controls remain future work. D1 and R2 are design options, not deployed dependencies.

## Development and acceptance

Local software development uses the console and simulated Go device with local persistence and disposable development credentials. Cloud acceptance covers Clerk sign-in and consent, OAuth audience and scope checks, workspace isolation, pairing, action results and grant revocation. Hosted authentication has passed service acceptance; physical board acceptance remains a separate step. See the [verification page](../apps/site/docs/status.mdx) for the current record.
