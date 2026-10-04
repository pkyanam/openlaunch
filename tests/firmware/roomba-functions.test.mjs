import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  roombaCapabilities,
  roombaFunctions,
} from "../../packages/core/src/roomba.ts";

const repo =
  process.env.OPENLAUNCH_REPO ??
  fileURLToPath(new URL("../../", import.meta.url));
const { Hub, manifestSchema } = await import(
  pathToFileURL(resolve(repo, "packages/core/src/index.ts")).href
);
const owner = { id: "owner", owner: true };
const agent = { id: "agent", owner: false };
const validArguments = {
  "roomba.stop": {},
  "roomba.sensor.read": { packetId: 7 },
  "roomba.leds.set": {
    ledBits: 15,
    powerColor: 128,
    powerIntensity: 255,
  },
  "roomba.tone.play": { note: 72, duration: 32 },
  "roomba.song.play": { songId: 3 },
  "roomba.brushes.burst": {
    mainBrush: true,
    sideBrush: false,
    vacuum: true,
    durationMs: 1000,
  },
  "roomba.resume_safe": {},
  "roomba.clean": { mode: "standard" },
  "roomba.dock": {},
  "roomba.pause": {},
  "roomba.drive": { velocityMmS: 120, radiusMm: 0, durationMs: 500 },
  "roomba.drive_direct": { rightMmS: 120, leftMmS: -120, durationMs: 500 },
};
const manifest = {
  name: "hall roomba",
  kind: "uno-r4-wifi",
  capabilities: ["device.health", ...roombaCapabilities],
  functions: roombaFunctions,
};

async function enrolledHub() {
  const hub = new Hub();
  const enrollment = await hub.enrollment(owner, manifest.kind);
  const device = await hub.enroll(enrollment.token, manifest);
  return { hub, device };
}

test("full adapter definitions validate as one generic device manifest", async () => {
  assert.equal(manifestSchema.safeParse(manifest).success, true);
  assert.deepEqual(
    roombaFunctions.map((definition) => definition.name).sort(),
    [...Object.keys(validArguments)].sort(),
  );
  const { hub } = await enrolledHub();
  assert.deepEqual(
    hub.functions(owner).map(({ definition }) => definition.name),
    roombaCapabilities,
  );
  assert.equal(
    manifestSchema.safeParse({
      ...manifest,
      capabilities: ["device.health", "roomba.drive"],
    }).success,
    false,
  );
});

test("each Roomba function requires and accepts only its own device grant", async () => {
  for (const functionName of roombaCapabilities) {
    const { hub, device } = await enrolledHub();
    assert.throws(() =>
      hub.request(
        agent,
        device.deviceId,
        functionName,
        validArguments[functionName],
        `no-grant:${functionName}`,
      ),
    );
    hub.grant(owner, agent.id, device.deviceId, [functionName]);
    assert.deepEqual(
      hub.functions(agent).map(({ definition }) => definition.name),
      [functionName],
    );
    assert.equal(
      hub.request(
        agent,
        device.deviceId,
        functionName,
        validArguments[functionName],
        `granted:${functionName}`,
      ).status,
      "queued",
    );
    for (const otherFunction of roombaCapabilities.filter(
      (name) => name !== functionName,
    )) {
      assert.throws(() =>
        hub.request(
          agent,
          device.deviceId,
          otherFunction,
          validArguments[otherFunction],
          `cross-grant:${functionName}:${otherFunction}`,
        ),
      );
    }
    hub.revokeGrant(owner, agent.id, device.deviceId);
    assert.equal(hub.functions(agent).length, 0);
  }
});

test("Roomba function schemas reject out-of-range and extra arguments", async () => {
  const invalidArguments = {
    "roomba.stop": [{ extra: true }],
    "roomba.sensor.read": [
      { packetId: 6 },
      { packetId: 43 },
      { packetId: 7, extra: true },
    ],
    "roomba.leds.set": [
      { ledBits: -1, powerColor: 0, powerIntensity: 0 },
      { ledBits: 16, powerColor: 0, powerIntensity: 0 },
      { ledBits: 0, powerColor: 256, powerIntensity: 0 },
      { ledBits: 0, powerColor: 0, powerIntensity: -1 },
    ],
    "roomba.tone.play": [
      { note: 56, duration: 1 },
      { note: 93, duration: 1 },
      { note: 72, duration: 0 },
      { note: 72, duration: 33 },
    ],
    "roomba.song.play": [{ songId: -1 }, { songId: 4 }],
    "roomba.brushes.burst": [
      { mainBrush: true, sideBrush: false, vacuum: true, durationMs: 0 },
      { mainBrush: true, sideBrush: false, vacuum: true, durationMs: 1001 },
      { ...validArguments["roomba.brushes.burst"], extra: true },
    ],
    "roomba.resume_safe": [{ mode: "full" }],
    "roomba.clean": [{}, { mode: "full" }, { mode: "spot", extra: true }],
    "roomba.dock": [{ extra: true }],
    "roomba.pause": [{ resume: true }],
    "roomba.drive": [
      { velocityMmS: -151, radiusMm: 0, durationMs: 1 },
      { velocityMmS: 151, radiusMm: 0, durationMs: 1 },
      { velocityMmS: 10, radiusMm: 2001, durationMs: 1 },
      { velocityMmS: 10, radiusMm: -2001, durationMs: 1 },
      { velocityMmS: 10, radiusMm: 0, durationMs: 0 },
      { velocityMmS: 10, radiusMm: 0, durationMs: 1001 },
    ],
    "roomba.drive_direct": [
      { rightMmS: -151, leftMmS: 0, durationMs: 1 },
      { rightMmS: 151, leftMmS: 0, durationMs: 1 },
      { rightMmS: 0, leftMmS: -151, durationMs: 1 },
      { rightMmS: 0, leftMmS: 151, durationMs: 1 },
      { rightMmS: 0, leftMmS: 0, durationMs: 0 },
      { rightMmS: 0, leftMmS: 0, durationMs: 1001 },
      { ...validArguments["roomba.drive_direct"], extra: true },
    ],
  };
  const { hub, device } = await enrolledHub();
  hub.grant(owner, agent.id, device.deviceId, roombaCapabilities);
  for (const [functionName, invalid] of Object.entries(invalidArguments)) {
    for (const args of invalid) {
      assert.throws(
        () =>
          hub.request(
            agent,
            device.deviceId,
            functionName,
            args,
            `invalid:${functionName}:${JSON.stringify(args)}`,
          ),
        `${functionName} should reject ${JSON.stringify(args)}`,
      );
    }
  }
});

test("read-only agents may read sensor packets but cannot invoke Roomba writes", async () => {
  const { hub, device } = await enrolledHub();
  hub.grant(owner, agent.id, device.deviceId, roombaCapabilities);
  const readOnlyAgent = { ...agent, readOnly: true };
  assert.equal(
    hub.request(
      readOnlyAgent,
      device.deviceId,
      "roomba.sensor.read",
      { packetId: 42 },
      "sensor-read-only",
    ).status,
    "queued",
  );
  for (const functionName of roombaCapabilities.filter(
    (name) => name !== "roomba.sensor.read",
  )) {
    assert.throws(() =>
      hub.request(
        readOnlyAgent,
        device.deviceId,
        functionName,
        validArguments[functionName],
        `write-read-only:${functionName}`,
      ),
    );
  }
});

test("compiled firmware feature schemas match SDK definitions and validate in openlaunch", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const emitted = spawnSync("sh", ["tests/host/roomba/manifest.sh"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(emitted.status, 0, emitted.stderr);
  const firmwareManifest = JSON.parse(emitted.stdout);
  assert.equal(manifestSchema.safeParse(firmwareManifest).success, true);
  function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !["description", "title"].includes(key))
          .map(([key, v]) => [key, normalize(v)]),
      );
    return value;
  }
  const sort = (definitions) =>
    definitions.map(normalize).sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(sort(firmwareManifest.functions), sort(roombaFunctions));
});
