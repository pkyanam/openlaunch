# openlaunch embedded protocol core

This is a dependency-free C++17 session and protocol core for constrained
devices. It is an additive library experiment; it does not replace or modify
the maintained Uno R4 sketch and is not a ready-to-flash board package.

Platform adapters implement `Transport`, `Clock`, and `Persistence`. The
transport owns JSON encoding/decoding and the HTTP client. It must use HTTPS
with certificate chain and hostname verification, route through the workspace
header, reject oversized/malformed responses, and never log bearer credentials.
`Persistence` must protect device identity using the platform's appropriate
storage. The current R4 firmware stores credentials in plaintext EEPROM, so it
does not meet a protected-storage claim.

The transport operations map to the current bridge API:

* `enroll`: `POST /v1/device/enroll` with `{token, manifest}`.
* `next`: `POST /v1/device/{deviceId}/next` with `{}`.
* `submitResult`: `POST /v1/device/{deviceId}/result` with
  `{actionId, status, result}`.

Every request uses `x-openlaunch-workspace`; authenticated device calls also
use `Authorization: Bearer <device credential>`. The transport adapter should
preserve server errors as `HttpError` or `InvalidResponse` rather than
pretending a call succeeded. Map authentication, validation, conflict, and
other non-retryable HTTP failures to `HttpError`; map network/timeout failures
to `NetworkError`.

The core uses fixed-capacity structures. The adapter serializes
`Manifest::functionsJson` as the optional `functions` array when `hasFunctions`
is true, and validates it against the bridge's function-definition contract.
Custom capabilities require that array. The core bounds its serialized size to
8192 bytes. The adapter serializes `Action`'s `argumentsJson` and
`ResultReport`'s `resultJson` as JSON values. The server currently limits
request bodies to 16 KiB and results to 4096 bytes. The caller
must implement each advertised capability and validate its arguments before
performing hardware side effects.

`nextAction` fails closed if wall-clock time is unavailable or the action is
expired. The server dispatches an action once (`queued` to `received`) and does
not currently redeliver it. Results are durably journaled with their action
expiry before transmission; on a network failure, call `retryResult()` until
confirmed before polling for more work. After reboot, call `resume()` and then
retry the pending result. Retry requires a trustworthy clock and stops at
expiry while preserving the pending record. `discardPendingResult()` is an
explicit operator action for abandoning that record; it never reruns the
device operation. A result can no longer be accepted once the server has
marked its received action `unknown` at expiry, so devices should retry
promptly and expose that ambiguous outcome to their operator. Enrollment
refuses to overwrite an identity already in persistence; call `resume()` for
a previously paired device.

## Native check

The host test compiles and executes with a local C++17 compiler:

```sh
node --test tests/embedded-sdk.test.mjs
```

This checks only the portable core. It does not compile an Arduino/ESP32/Linux
transport, verify TLS behavior, or validate hardware operation.
