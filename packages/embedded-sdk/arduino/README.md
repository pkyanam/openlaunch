# ESP32 Arduino adapter

This adapter implements the portable core's HTTP transport,
clock, and Preferences-backed storage for ESP32 Arduino core 3.x. The compile
smoke check below used core 3.3.11 and ArduinoJson 7.4.3. It currently
supports SDK-token attachment, legacy enrollment, action polling, and result submission. It does not publish
manifest updates, execute arbitrary functions, or change existing R4 firmware.

The transport requires an HTTPS origin, a 64-character lowercase hexadecimal
workspace ID, and a supplied PEM root certificate containing
`BEGIN CERTIFICATE`. It uses `NetworkClientSecure::setCACert`, disables
redirect following, sends workspace and device bearer headers, limits
serialized requests to 16 KiB, and reads responses into an 8 KiB bounded
buffer. TLS verification has no insecure fallback. The board clock must be set
by the application before actions can be accepted or results retried; the
example starts SNTP and the core fails closed until time is plausible.
Non-2xx responses map to the portable `HttpError` status; inspect
`lastHttpStatusCode()` on the ESP32 transport to distinguish authentication or
validation failures from responses that may be transient. Network timeouts map
to `NetworkError` and may be retried while the action remains unexpired.

`Esp32Preferences` stores identity and pending results in ESP32 NVS. This is
plaintext at rest unless the device separately enables and provisions ESP32
flash/NVS encryption. Erasing the `openlaunch` Preferences namespace removes
the stored identity; do this deliberately before pairing another identity.

## Pair over USB

Upload the included health example to an identified standalone ESP32 board. The example takes configuration at runtime; Wi-Fi passwords and tokens are never compiled into its source.

Create an SDK token with an available device attachment slot in the openlaunch console. Run the hosted USB provisioner with the confirmed serial port:

```sh
curl -fsSL https://www.openlaunch.dev/downloads/provision-esp32.py -o provision-esp32.py
python3 provision-esp32.py --port /dev/cu.YOUR_CONFIRMED_PORT --origin https://www.openlaunch.dev
```

The helper prompts for Wi-Fi details and one SDK token, derives the workspace, verifies HTTPS, and asks before configuring the board. For another HTTPS service, explicitly supply its trusted public root certificate with `--ca-file`. Host verification does not establish physical board TLS acceptance.

NVS holds the configuration and stable attachment request before network exchange. Retry the same request after a lost response; after the conservative recovery window expires, inspect device inventory before resetting setup. Once a child identity is stored and read back, the runtime clears the SDK bootstrap token. An existing identity is never silently replaced.

The example supports bounded serial JSON `status`, `configure`, `reset`, and `discard_pending_result` commands. A pending result blocks further execution until delivered; explicitly discarding an uncertain result is an owner recovery action, not proof that hardware succeeded.

## Source checkout and distribution

The checked-in adapter includes the core from the adjacent `include` directory.
Build the standalone Arduino archive from the repository root with:

```sh
node scripts/package-embedded-sdk.mjs
```

The resulting `openlaunch-esp32.zip` contains a conventional `openlaunch`
Arduino library directory with the portable header included under `src`. To
install it, use Arduino IDE’s **Sketch → Include Library → Add .ZIP Library**. The
example then includes `<openlaunch.h>` and can be compiled with the
installed library and ArduinoJson 7.4.3. The archive is sanitized from an
explicit source allowlist; it does not include local configuration, build
outputs, or firmware repair files.

The repository's compile smoke check uses the installed ESP32 core and local
ArduinoJson dependency, does not flash or contact a board, and can also compile
the extracted standalone archive.

The hosted archive is available at `https://www.openlaunch.dev/downloads/openlaunch-esp32.zip`.
