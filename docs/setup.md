# Setup

Start with the [current README](../README.md) or the [hosted setup guide](https://www.openlaunch.dev/docs/setup).

```sh
curl -fsSL https://www.openlaunch.dev/setup.sh | bash
```

The menu offers Uno, ArduRoomba, Pi, standalone ESP32, custom Node adapters, and a local developer console. USB helpers configure already-flashed firmware; they never update the ESP connectivity image. Downloads and checksums come from the deployed GitHub commit.

The hosted console, Clerk owner/OAuth sign-in, Cloudflare bridge, and workspace SQLite storage are deployed. Device setup credentials, agent connections, and per-function grants are separate. Select the actual agent connection under a device’s Access view and save its function grant. ChatGPT through Executor needs an Executor grant.

For source development, run `npm run setup`. For guided Uno compilation, run `npm run setup:firmware`. Deployment and hardware acceptance details are in [Mac handoff](MAC-HANDOFF.md) and [transport profiles](UNO-R4-PROFILES.md). Physical Roomba operation remains unverified. Keep private repair assets and credentials outside Git.
