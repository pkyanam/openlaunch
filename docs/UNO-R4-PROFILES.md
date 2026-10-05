# Uno R4 WiFi transport profiles

`npm run build:firmware` and the firmware step in `npm run verify` default to **stock**. Both profiles compile the same openlaunch sketch with `arduino:renesas_uno@1.6.0`. LED, matrix text, HTTPS polling, provisioning and capabilities are unchanged. Selection is a build choice because the WiFiS3 global modem instance determines the UART transport.

Stock boards require stock ESP connectivity firmware and stock WiFiS3. The repaired board requires the matching custom ESP 0.6.0 mux image and patched WiFiS3. Never mix these pairs or automatically select a profile from a USB board name. The build does not detect the installed ESP firmware or establish that the board works.

For guided dependency setup and compilation, run `npm run setup:firmware`. It asks for the transport and application, requires explicit acknowledgment for an already-installed mux image, and never flashes. The manual path remains available: run `npm run prepare:firmware` and install isolated dependencies as described in [Mac handoff](MAC-HANDOFF.md). Preparation validates and stages sources and writes configuration without compiling or downloading. To prepare the repaired profile instead, use:

```sh
npm run prepare:firmware -- --profile console-mux \
  --repair-dir "$HOME/Code/uno-r4-wifi-fix" --acknowledge-installed-mux
```

The isolated dependencies are shared, so install them once using either prepared profile's config. Then build the repaired profile explicitly:

```sh
npm run build:firmware -- --profile console-mux \
  --repair-dir "$HOME/Code/uno-r4-wifi-fix" --acknowledge-installed-mux
```

The acknowledgement means the owner has established that the matching custom image is already installed. This command only checks local source/image integrity; it cannot read the flashed image. It does not install, restore or flash either chip. Do not run the standard connectivity updater on this board while the mux pair is selected.

The repair bypasses RA P501/D24 → ESP GPIO6 requests through the healthy console UART RA P109/D22 → ESP GPIO44. Responses remain ESP GPIO5 → RA P502/D25. USB D+/D− are not repurposed. Request frames contain `00 FF 00 FE`, a uint16 little-endian payload length, and up to 1024 bytes per sender chunk. The ESP demultiplexes frames into its existing AT interpreter and forwards ordinary console traffic to USB. Console return uses ESP GPIO43 → RA P110/D23. Keep `Serial` at 115200; do not end it, change its baud, write concurrent frame traffic, or invoke the modem from an ISR.

The build verifies stock Modem.h/.cpp fingerprints, the repair patch fingerprint and the local production mux image fingerprint before patching a staging copy. The reference SHA-256 values are in `scripts/firmware.mjs`. The checked image is `firmware/UNOR4-WIFI-S3-0.6.0-mux.bin`, SHA-256 `b2ec3425bc189a69fd31baeee30766156d1ab6504f7b05f45c4c0f481281e216`. Other versions/debug images require a reviewed provenance update. The image is read only to hash it and is never copied. The patch is applied only to the ignored staging library; the repair folder and global libraries remain unchanged.

Each profile has its own `build/firmware/PROFILE/compiled` artifacts, provenance record and compiler result. The isolated dependency directory is shared. Arduino environment overrides are removed for CLI subprocesses; the selected WiFiS3 is passed as a singular explicit library, and the compiler's actual resolved library path must match it. A mismatched library, source hash, missing core, unknown profile or incomplete mux selection fails the build.

Upload only after independently confirming the board and chosen pair. Use the compiled artifact directory from the intended profile as `arduino-cli upload --input-dir`, as shown in the handoff. An upload command without that directory may use a different artifact. `npm run verify -- --profile console-mux --repair-dir ... --acknowledge-installed-mux` verifies the selected mux build; run stock verification separately to cover both profiles.

These are separate owner-operated upload commands, after a successful build of the corresponding profile. Choose exactly one for the identified board; neither command compiles the sketch:

```sh
# Stock board, after successful stock build:
arduino-cli upload --fqbn arduino:renesas_uno:unor4wifi \
  --port /dev/cu.YOUR_CONFIRMED_PORT --input-dir build/firmware/stock/compiled

# Repaired board, after successful console-mux build and firmware-pair confirmation:
arduino-cli upload --fqbn arduino:renesas_uno:unor4wifi \
  --port /dev/cu.YOUR_CONFIRMED_PORT --input-dir build/firmware/console-mux/compiled
```

CI prepares, installs dependencies and compiles stock through the same isolated runner. CI cannot validate console-mux without the owner's external repair assets; those are deliberately excluded from the repository.

## ArduRoomba sketch

The `openlaunch_roomba` sketch exposes its implemented functions automatically, including standard cleaning, spot/max cleaning, docking and pause. It publishes its compact function contract at boot; openlaunch supplies agent-facing documentation. A changed contract requires reviewing device grants again.

Use the pinned ArduRoomba commit `5120998789100c1aade14ebe0645524cae6f9349` and install `ArduinoBLE@2.1.0` in the isolated dependency directory. Select the sketch explicitly:

```sh
node scripts/firmware.mjs --sketch openlaunch_roomba \
  --roomba-library /path/to/ArduRoomba
```

For the repaired board, also pass the console-mux arguments above. This sketch has separate staging, provenance and compiled artifacts under `build/firmware/PROFILE/openlaunch_roomba/`; uploads must use that sketch's `compiled` directory. The main-chip upload preserves the ESP connectivity firmware.

Provision with the native Uno setup helper or `python3 scripts/provision-roomba.py`. Wi-Fi settings and a device setup token are entered interactively; agent OAuth/API credentials stay outside the board. The default Roomba wiring policy is `serial_only`: VIN/GND, Serial1 D0/D1 and BRC D5; D6/D7 are unused. Direct wheel and brush commands retain their one-second local deadlines and Safe-mode operation. An owner can select `ROOMBA_REQUIRE_LOCAL_CONTACTS = true` in `RoombaLocalControl.h` before building for separate D6/D7 switches. These optional contacts are software inputs, not an independent emergency stop: synchronous network calls can delay their handling. The health and USB status results expose `controlWiring`, `controlReady` and `sensorLinkDesynced`; a health read does not abort an autonomous run. Read [API coverage](API-COVERAGE.md) before wiring and testing. Compilation and successful device health do not verify Roomba operation.

No repair patch, library or firmware binary is distributed in this repository. The installed Renesas core has an MIT license, but the local repair modifications and bridge tree have no top-level license establishing redistribution permission; vendored components have separate licenses. Keep repair assets local until provenance and permission are reviewed. Bridge rebuilding also requires the repair workbench's patched ESP 2.0.9 toolchain, certificate generation and image combiner; the ordinary RA application build does not rebuild it.

Compilation proves toolchain compatibility only. Hardware acceptance still needs Wi-Fi/TLS/clock, USB provisioning, actual LED/matrix observation, restart/reconnect and upload-to-application transition on both board profiles. Historical workbench tests are not openlaunch hardware validation.

Sensor reads drain at most 2048 unsolicited UART bytes within 100 ms and require 20 ms of quiet before sending a query. A pre-query backlog can recover on a later request; a query timeout remains latched until restart to avoid attributing a late reply to a new request. This handles bounded startup text, not an incorrect baud rate or continuously noisy wiring. Sensor expiry checks reserve 225 ms for synchronization and the pinned library read. No result claims physical verification.

### Roomba link initialization and receipts

The adapter sends a separate 100 ms BRC wake pulse before the two-second wait
and three 100 ms baud-selection pulses. UART remains Serial1 at 19200. After
stopping outputs at boot, it returns to Passive mode so idle initialization
does not leave charging disabled. Packet 35 must return a valid OI mode; the
library's `isConnected()` flag alone only establishes local UART initialization.

Before cleaning, docking, recovery, wheel or brush commands, the adapter repeats
the bounded wake/baud sequence, sends Start/Safe, and reads OI mode. Manual
outputs require a confirmed Safe response; cleaning/docking accept Passive or
Safe because the native autonomous routines enter Passive mode. Full mode is
not enabled. Expiry includes initialization time and is checked again before
outputs. Per-function grants and the persistent write journal remain required.

USB status and health expose `roombaUartInitialized`, `roombaLinkVerified`,
`oiMode` (255 means unknown), `linkCheckedAtMs`, `linkError`, and
`linkDiscardedRxBytes`. These describe the last link check; health does not issue
OI commands or interrupt cleaning. A timeout requires adapter restart after
checking/waking the robot. Older Roomba firmware can fail to wake through BRC
while docked, so physical CLEAN wake may be necessary. See the manufacturer's
[500-series OI specification](https://cps-vo.org/sites/cps-vo.org/files/cpsvo_file_nodes/iRobot_Roomba_500_Open_Interface_Specpdf.pdf)
and [updated dock-wake notes](https://cdn.hackaday.io/files/1835247851890816/2021-04-13_iRobot_Roomba_600_Open_Interface_Spec-3.pdf).

`serial_command_sent` confirms transmission, never observed cleaning or docking.
Activity labels these receipts as operation unverified. Result delivery retries
send only a saved receipt. After its TTL, the service can acknowledge an already
stored identical terminal outcome; it rejects a new late, conflicting, unknown,
or revoked outcome. The adapter compares JSON values independent of object key
order and clears its pending journal only after exact confirmation. Uncertain
outcomes remain blocked; no command is replayed or pairing identity erased.
