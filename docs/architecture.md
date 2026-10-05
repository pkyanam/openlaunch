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

Clerk provides hosted owner sign-in and agent OAuth. The hosted service verifies owner sessions and OAuth access tokens against the configured issuer. OAuth uses PKCE and resource audiences; built-in agent identities are configured explicitly. Owners register other OAuth clients in Connections with exact callbacks, a read/action ceiling, enforced PKCE and consent. Admission requires an active client record in the verified user's workspace; it never derives from model-supplied metadata. Client secrets are returned once and excluded from workspace storage and audit. Google is the enabled sign-in provider, and email/password sign-in is disabled.

Owner sessions and agent identities are separate. An owner creates an `ol_agent_` API connection with read or action access and a finite or until-revoked lifetime, or admits an agent through OAuth. These agent credentials cannot attach devices. Device setup uses a separate short-lived `ol_sdk_` token, attach-only, with a default lifetime of 10 minutes and a default limit of one device. Attachment returns a private child credential; the setup token is not saved in the device identity, and the child credential remains valid when its setup token expires or is revoked. Removing the device revokes its child credential. Existing untyped combined connection records remain supported for compatibility, but new integrations must use separate setup and agent credentials. Legacy board-bound enrollment codes remain single-use and expire after 10 minutes. Attachment does not grant an agent permission to use device functions. The owner separately grants functions on each device for a bounded period or until explicitly revoked; a token cannot grant itself. Read-only agent connections cannot issue commands. Revoking an agent connection removes its grants and stops its API access.

The hosted service derives each workspace's SQLite Durable Object identity from the verified Clerk issuer and user identity. Within that object, individual records are stored in native SQLite and changed rows commit together in a transaction; polling does not rewrite the entire action ledger. The first access migrates the earlier KV snapshot, preserves a backup and installs a guard that prevents an older Worker from using stale permissions. See the deployment guide before rolling back this storage change. Requests are isolated by workspace. Agent requests are checked for their OAuth scope or `ol_agent_` API access and a live per-device function grant on each call, including calls made through previously discovered custom-function tools. A persistent grant remains active until the owner revokes it. An ungranted action and an agent's attempt to grant itself are rejected; device attachment separately authenticates the `ol_sdk_` setup token and enforces its device limit.

The shared core admits new records within a 16 MiB logical storage budget, including reserved capacity for pending command results and the bounded audit ring. Quota checks apply to every transport before growth is committed. Already received results and access revocation remain available when a legacy workspace exceeds the limit; new work and queued dispatch pause. Idempotent retries return their existing receipt without using additional capacity.

## Commands and device functions

An authorized MCP request becomes a typed, bounded action. Devices initiate outbound HTTPS polls, receive commands and report correlated results. Queued, received and terminal states are distinct. Expiry and revocation are enforced by the service. If a device disconnects or loses an acknowledgment, the physical outcome can remain unknown; the system does not promise exactly-once execution.

Devices may advertise functions in their manifest. Definitions include a name, title, description and input schema. Supported input fields are bounded strings, bounded numbers or integers, and booleans in a root object that rejects additional properties. Manifests are limited to 16 functions and 16 parameters per function, reject external schema references and cannot replace built-in capabilities. An owner can grant custom functions individually; approved functions are returned by the stable `list_functions` MCP tool and can be called through `invoke_device_function`, even when a host caches its original tool list. They also appear as device-specific MCP tools during discovery. Both invocation paths check current grants and exact device argument schemas on every call.

The `POST /v1/broadcasts` endpoint can request the same action for up to 20 devices. It returns an independent action or error for every device, so a broadcast is not an atomic multi-device operation.

## Device SDK boundaries

The cloud service accepts bounded custom device kinds without a board-specific service change. A device adapter owns its hardware drivers, credential storage, manifest and execution. The shared protocol owns attachment, polling and correlated results. Attachments use a durable request UUID and manifest fingerprint; a lost response can recover the same identity within 10 minutes. The service derives the child credential with a versioned, server-only HMAC keyring, stores only its hash, and rejects expired or changed retries rather than creating another device. Agent integrations use the same API and grants; `GET /v1/functions` returns only the advertised built-in and custom functions the current agent may call, with exact device schemas and bounded explanatory guidance. Provider credentials never reach firmware.

Linux and desktop custom adapters can use the Node SDK and its setup/publish/run CLI. The maintained Go runtime has a lightweight Pi health profile and an opt-in [Linux host profile](LINUX-HARNESS.md) with scoped files, named commands, metrics and user services. Local policy is independent of cloud per-function grants. Policy revisions revoke previous grants, including changes behind existing aliases. Native microcontroller adapters speak the same HTTPS contract, using platform TLS and storage. Pi, Uno and standalone ESP32 setup use the same attach-only `ol_sdk_` setup token. USB helpers prompt for credentials and configure runtime storage; secrets are not compiled into sketches. An ESP32 development board is not the Uno R4 connectivity coprocessor; support for one must not alter the other's transport firmware.

The Node runner, Go Pi runtime and Uno firmware keep durable result journals so a failed result upload can retry the saved outcome without rerunning the hardware handler. This reduces duplicate work after interruption but does not promise exactly-once physical execution.

Manifest changes require owner reapproval. They revoke prior device grants, cancel queued commands and preserve uncertainty for commands already received. A schema describes implemented behavior; advertising a function cannot install a driver or make an unsupported board operation work.

## Trust boundaries and runtime support

Cloudflare is a trusted relay. TLS protects each network hop; it does not provide end-to-end encryption from the model host to the board. R4 credentials are stored in plaintext in EEPROM; Pi credentials use a restricted local file. Physical compromise can expose them. Commands are typed and bounded; unrestricted shell access and arbitrary LAN proxying are not default capabilities.

The Go Pi health profile reports process health; the Linux host profile adds real host operations with an unprivileged user policy. Its GPIO and display control adapters are not implemented. Uno R4 firmware supports health, the built-in LED and matrix text. Runtime acceptance on physical boards—including network, TLS, provisioning, power-loss and reconnect behavior—is still pending. Health and simulated results must not be represented as successful physical actions.

## Delivery and deployment

The Node adapter uses an authenticated WebSocket as a wake signal. Its one-use ticket expires after 30 seconds and is passed in the WebSocket handshake header. The channel sends only a payload-free work hint; the adapter reads actions and reports outcomes over HTTPS. Its 10-second HTTP polling fallback remains. Go, Uno and ESP32 runtimes continue to poll over HTTPS every 10 seconds. The hosted bridge uses a Cloudflare Worker and one SQLite-backed Durable Object per workspace. The public documentation site is a separate Cloudflare Pages deployment; its `/docs-mcp` endpoint serves read-only documentation tools and does not control devices.

The public website is served at `www.openlaunch.dev`; the apex redirects to `www`. Vercel remains authoritative for DNS. The hosted service and website deployments are independent. See [website deployment](WEBSITE-DEPLOYMENT.md) for deployment and domain details.

WebSocket wake hints are deployed for the Node adapter; extending event-driven wakeups to firmware remains future work. OTA signing and rollback, durable event subscriptions, broader quotas and account lifecycle controls also remain future work. D1 and R2 are design options, not deployed dependencies.

## Development and acceptance

Local software development uses the console and simulated Go device with local persistence and disposable development credentials. Deployed acceptance on commit `6e317a0` covered the then-current legacy combined SDK-token flow: stable attachment retries after a lost response, non-persistence of the master token, no default grants, forbidden ungranted actions and self-grants, quota rejection, owner grants, manifest-change revocation, and Node WebSocket wake hints followed by HTTPS action checks. These results do not verify the current split token-purpose routes or persistent-grant option. The 601 ms health and 508 ms `custom.echo` results came from a software fixture, not physical hardware. See the [verification page](../apps/site/docs/status.mdx) for the current record; physical board acceptance remains separate.
