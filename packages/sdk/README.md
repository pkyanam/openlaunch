# @openlaunch/sdk

The provider-neutral TypeScript client for openlaunch agents and device bridges. It works with Node 22.18+ and runtimes that provide `fetch` and `AbortSignal.timeout`.

```sh
npm install https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz
```

Source: [pkyanam/openlaunch/packages/sdk](https://github.com/pkyanam/openlaunch/tree/main/packages/sdk). The hosted download is built from the same commit as the website.

## Agent quick start

Create an agent connection in the openlaunch console, then keep the generated token in your agent's secret store. Give the connection only the device capabilities it needs.

```ts
import { createClient } from "@openlaunch/sdk";

const openlaunch = createClient({
  url: "https://www.openlaunch.dev",
  token: process.env.OPENLAUNCH_TOKEN!,
});

const devices = await openlaunch.listDevices();
const action = await openlaunch.requestAction(devices[0].id, {
  capability: "device.health",
  idempotencyKey: "health-check-2026-10-04T12:00:00Z",
});

// `queued` means the bridge accepted the request. Poll until the board reports
// a terminal state; a queued request is not a completed action.
let current = action;
while (["queued", "received"].includes(current.status)) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  current = await openlaunch.getAction(action.id);
}
console.log(current.status, current.result);
```

Use a new idempotency key for each new action. Reuse the same key only when retrying the exact same request after a network failure. `cancelAction` can cancel an action only before a device receives it. `broadcast` returns a separate queued action or error for each target device.

## Bring a device online

Pairing produces a short lived, one-use enrollment token. Pass it directly to the device process; the bridge returns its own long lived device credential. Store that credential in the device's secret store and pass it back through `credential` after a restart.

```ts
import { createDevice } from "@openlaunch/sdk";

const bridge = createDevice({
  url: "https://www.openlaunch.dev",
  workspace: process.env.OPENLAUNCH_WORKSPACE!,
});

const enrolled = await bridge.enroll({
  token: process.env.OPENLAUNCH_ENROLLMENT_TOKEN!,
  manifest: {
    name: "Workshop sensor",
    kind: "custom.device", // Any short lowercase kind identifier is allowed.
    capabilities: ["custom.sensor.read"],
    functions: [
      {
        name: "custom.sensor.read",
        title: "Read temperature",
        description: "Return the current temperature in Celsius.",
        access: "read",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ],
  },
});

// Persist enrolled.token securely. For a managed poll loop with a durable
// execution/result journal, use openlaunch-device setup/run below.
const action = await bridge.nextAction();
if (action) {
  let outcome;
  if (action.capability !== "custom.sensor.read") {
    outcome = { status: "failed", result: { code: "unsupported_capability" } };
  } else if (Date.now() >= action.expiresAt) {
    outcome = { status: "failed", result: { code: "expired" } };
  } else {
    try {
      outcome = { status: "succeeded", result: await readTemperature() };
    } catch {
      outcome = { status: "failed", result: { code: "sensor_error" } };
    }
  }
  // Save the outcome durably before attempting this upload. If upload fails,
  // retry this same outcome; never execute the sensor operation again.
  await bridge.submitResult(action.id, outcome);
}
```

For a long running device process, call `nextAction()` on an interval. It returns `null` when there is no queued work. The service supports an outbound HTTPS polling bridge, so boards do not need inbound ports or a LAN proxy. Use the maintained Uno R4 WiFi or Raspberry Pi bridge when available; custom boards implement the small manifest and poll/result contract above.

## Adapter setup and extension

Choose **Pair another device** in the portal, then run:

```sh
npx --yes --package=https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz openlaunch-device setup
```

The command prompts for the workspace and one-use code, creates `adapter.mjs`, saves a private device identity and starts outbound polling. The starter's health result describes the adapter process. Connect your own library, serial board or local service in `handlers`, then declare those implemented operations in `manifest.functions`.

Publish your changed manifest with the same command ending in `publish`, approve its functions in the portal, and restart with `run`. Existing device grants are removed when a manifest changes. The runner keeps a private action journal to avoid rerunning handlers after result-upload failures or interrupted execution. No operation is promised to execute exactly once across physical power loss.

## Transport and errors

All agent and device operations use HTTPS. HTTP is allowed for `localhost`, `127.0.0.1`, and `::1` during local development. Both factories accept a `fetch` override for testing and alternate runtimes. For a local bridge, pass its workspace routing ID; hosted credentials are bound to their workspace.

Failures throw `OpenLaunchError` with `status` and a safe `code`. Error messages intentionally omit server response text and credentials. Device credentials remain in memory inside the SDK instance; the caller is responsible for securely persisting the credential returned by enrollment.
