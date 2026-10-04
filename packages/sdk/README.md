# @openlaunch/sdk

The provider-neutral TypeScript client for openlaunch agents and device bridges. It works with Node 22.18+ and runtimes that provide `fetch` and `AbortSignal.timeout`.

```sh
npm install 'https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz'
```

Source: [pkyanam/openlaunch/packages/sdk](https://github.com/pkyanam/openlaunch/tree/main/packages/sdk). The hosted download is built from the same commit as the website.

## Agent quick start

Create an SDK token in the openlaunch console and keep it in your secret store. The same token can authenticate an agent and attach devices when the owner enables a bounded device limit. Device access still requires separate owner-approved grants.

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

Use an owner-issued SDK token with device attachment enabled. It is used only to exchange the device manifest for a private device credential; the device polls with that child credential. The token's workspace is encoded in the token, so setup does not ask for a separate workspace ID.

```ts
import { createDevice } from "@openlaunch/sdk";

// Persist this ID with your adapter's durable state before the first attach.
// On restart, load it instead of generating another ID.
const attachRequestId = crypto.randomUUID();
await adapterState.write("attachRequestId", attachRequestId);

const bridge = createDevice({
  url: "https://www.openlaunch.dev",
  token: process.env.OPENLAUNCH_SDK_TOKEN!,
});

const identity = await bridge.attach(
  {
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
  attachRequestId,
);

// Persist identity.token securely. Reuse the same request ID and manifest if
// retrying attach after a network failure within the 10-minute retry window.
// For a managed poll loop with a durable credential file and execution/result
// journal, use openlaunch-device setup/run below.
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

In the portal, open **Devices**, select **Add device**, then choose **Linux / desktop Node adapter**. Run:

```sh
npx --yes --package='https://www.openlaunch.dev/downloads/openlaunch-sdk.tgz' openlaunch-device setup
```

The command prompts once for the SDK token (or reads `OPENLAUNCH_SDK_TOKEN`), creates `adapter.mjs`, saves the private device credential and starts outbound polling. It stores a non-secret request ID before attaching, so rerunning setup after a network failure safely retries the same request. It never saves the SDK token. The starter's health result describes the adapter process. Connect your own library, serial board or local service in `handlers`, then declare those implemented operations in `manifest.functions`.

Publish your changed manifest with the same command ending in `publish`, approve its functions in the portal, and restart with `run`. Existing device grants are removed when a manifest changes. The runner keeps a private action journal to avoid rerunning handlers after result-upload failures or interrupted execution. A mismatched receipt retains the journal and stops new command intake. An interrupted execution is reported as `outcome_unknown` and stops intake across subsequent restarts. Inspect the device before recovery; revoke the old device identity and use `setup --directory ./recovered-adapter` for a replacement, preserving the original private journal. No operation is promised to execute exactly once across physical power loss.

## Transport and errors

All agent and device operations use HTTPS. HTTP is allowed for `localhost`, `127.0.0.1`, and `::1` during local development. Both factories accept a `fetch` override for testing and alternate runtimes. For a local bridge, pass its workspace routing ID; hosted credentials are bound to their workspace.

Failures throw `OpenLaunchError` with `status` and a safe `code`. Error messages intentionally omit server response text and credentials. Device credentials remain in memory inside the SDK instance; the caller is responsible for securely persisting the credential returned by attach. The legacy one-use enrollment API remains available for existing integrations.
