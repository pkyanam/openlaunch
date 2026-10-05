# Linux harness

The Go device runtime now has an opt-in `linux` host profile. It keeps the Pi health-only profile and all embedded transports intact. The public guide is [Linux host control](https://www.openlaunch.dev/docs/linux).

## Muse comparison

Baseline reviewed: [Muse Linux SDK at 74a5e2d](https://github.com/facebookincubator/muse-gadget-sdk/tree/74a5e2d7fc895f109f83a9a1dbed705dbcd8b1ff/linux). This comparison concerns the published Linux implementation, not unreleased Muse features. The implementation was written independently.

| Area                 | Muse Linux SDK                                                       | openlaunch Linux profile                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published operations | `system.run`, `file.read`, `file.write`, `device.health`             | Up to 15 functions, adding directory management, file metadata and removal, upload abort, process inspection, network inventory and named user-service control/logs |
| Commands             | Bash command string, working directory, timeout                      | Locally named fixed argv, directory and timeout; agent cannot supply arbitrary shell input                                                                          |
| Files                | Absolute paths under the execution user's permissions; 64 KiB chunks | Explicit root aliases, read-only/write policy, rooted filesystem access; 2 KiB reads / 6 KiB writes / 2 MiB upload budget                                           |
| Publication          | Chunked writes with optional SHA-256                                 | Required SHA-256 on final chunk, atomic create-if-absent and explicit revision-checked replacement                                                                  |
| Health               | Host metrics including uptime/load/memory/disk/model/temperature     | Host metrics plus separate adapter uptime, kernel/distribution and network/process functions                                                                        |
| Agent access         | Muse pairing and account permissions                                 | Provider-neutral OAuth/API, exact per-function grants, dynamic API/MCP/CLI discovery; policy changes revoke grants                                                  |
| Installation         | System service, configured run-as account, phone/BLE pairing         | Verified standalone binary, hidden setup-token prompt, user PATH and optional user service; no sudo or BLE requirement                                              |
| Persistence          | Persistent system service                                            | Optional persistent user service; reboot without user login needs owner-enabled lingering                                                                           |
| Device-to-agent chat | `send-user-msg`                                                      | Not implemented; action receipts and polling only                                                                                                                   |
| Encryption           | Muse's BLE/Noise pairing and connection model                        | Outbound HTTPS with Cloudflare as a trusted relay; not agent-to-device end-to-end encryption                                                                        |

openlaunch provides a broader set of structured host functions and independently enforceable local policy and cloud grants. It does not claim full parity with Muse's unrestricted shell, larger transfer envelopes, BLE pairing or device-initiated chat. Expanding those areas requires deliberate design rather than advertising unsupported behavior.

## Architecture

- `linux_policy.go`: private owner policy, manifest schemas and revision fingerprint. A manifest embeds the revision, so changing roots, argv or services requires reapproval even when aliases stay unchanged.
- `linux_files.go`: rooted file operations, private ordered upload staging, SHA-256, bounded transfer count/bytes, expiry and atomic publication. No recursive deletion or arbitrary absolute agent paths.
- `linux_exec.go`: strict device-side arguments, real Linux host metrics, procfs inventory, interface inventory, bounded subprocess output, remaining-TTL deadlines and process-group cancellation. No agent credentials or provider dependencies.
- `linux_cli.go`: local owner policy commands, single-runtime advisory lock and systemd user-service setup.
- `events.go`: authenticated one-use-ticket WebSocket wake hints with bounded frames, heartbeat, reconnect backoff and cancellation. Hints only wake HTTPS polling; they cannot execute actions or bypass result-retry backoff. The same channel already serves the Node adapter.
- Existing `main.go`: attach-only setup token exchange, child credentials, authenticated outbound polling and durable action/result journal. The `raspberry-pi-4` profile retains health-only behavior and gains optional wake notifications.

The shared function schema permits strings up to 8192 characters only for the `linux` kind. Other manifests retain their 1024-character ceiling. HTTP body limits, embedded device manifests, result limits and pending-result reservations remain unchanged. Linux response reading is bounded at 64 KiB to accommodate full action receipts, which echo arguments and their internal idempotency fingerprint; the Pi profile retains its 16 KiB response ceiling.

The installer and ARM64/ARMv7/x86-64 downloads come from the same CI commit as the site. No new cloud service or subscription is required. A new owner policy takes effect after runtime restart; startup publishes it before accepting new commands and fails closed if publishing or reconciling an existing result fails.

Rerunning the Linux installer upgrades the binary without attachment or policy initialization. It validates the private saved configuration, policy and journal first, then atomically replaces the verified executable under the existing runtime lock. Active user services stop and restart; failed starts restore the previous binary. Foreground runners must stop before replacement. Credentials, journal and upload staging are never restored from a stale snapshot or erased by update rollback. Existing unchanged manifests retain their grants.

MCP receipts expose action state and results without the internal owner-bypass marker. Pending receipts instruct the agent to check the same action until terminal or its deadline. Hosted Linux inventory guidance describes optional `model` and `temperatureC` fields without changing the device manifest or revoking existing grants.

## Acceptance

Run `npm run test:device` for real local filesystem, policy and subprocess tests, including traversal/link/special-file rejection, read-only roots, staged upload ordering/integrity/expiry, atomic create/replace, deadlines, duplicate delivery and exclusive runtime ownership. Run `npm run test:linux` on Linux for the same acceptance test used in CI (`scripts/linux-e2e.mjs`): actual host profile → authenticated local HTTP bridge → grant-filtered MCP → host execution → result receipt. Its disposable local software credentials are never production tokens.

On October 5, 2026, the owner's real Pi returned a successful cloud `system.info` receipt: Raspberry Pi 4 Model B Rev 1.5, ARM64, four CPUs, Debian 13, approximately 4 GB OS-visible RAM and 37°C. The old runtime waited 8.3 seconds for its idle poll; dispatch-to-receipt took 99 ms. This verifies basic hardware inventory, not the new notification/update path. Target acceptance still needs the upgraded runtime, a file round trip, an explicitly configured command, allowed user-service actions, reboot/reconnect and revocation. Do not advertise software tests as these physical checks. GPIO, system services, arbitrary LAN forwarding and device-to-agent chat are not implemented.
