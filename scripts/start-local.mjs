import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
if (!existsSync("apps/web/dist/index.html")) {
  console.error("Run npm run setup first to build the console.");
  process.exit(1);
}
const owner = randomBytes(32).toString("hex");
const agent = randomBytes(32).toString("hex");
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid PORT");
const origin = `http://127.0.0.1:${port}`;
mkdirSync(".cache/local", { recursive: true, mode: 0o700 });
chmodSync(".cache/local", 0o700);
for (const [name, token] of [
  ["owner", owner],
  ["agent", agent],
]) {
  const path = `.cache/local/${name}.json`;
  writeFileSync(path, JSON.stringify({ origin, token }), { mode: 0o600 });
  chmodSync(path, 0o600);
}
const credentialKeyPath = ".cache/local/credential-keys.json";
if (
  existsSync(credentialKeyPath) &&
  (!lstatSync(credentialKeyPath).isFile() ||
    lstatSync(credentialKeyPath).isSymbolicLink())
)
  throw Error("Credential key path must be a regular private file");
if (!existsSync(credentialKeyPath))
  writeFileSync(
    credentialKeyPath,
    JSON.stringify({ v1: randomBytes(32).toString("hex") }),
    { mode: 0o600, flag: "wx" },
  );
chmodSync(credentialKeyPath, 0o600);
const deviceCredentialKeys = readFileSync(credentialKeyPath, "utf8");
const copied =
  process.platform === "darwin" &&
  spawnSync("pbcopy", [], { input: owner }).status === 0;
console.log("openlaunch console: " + origin);
if (copied)
  console.log(
    "Your session key is on the clipboard. Paste it into the console, then clear the clipboard.",
  );
else
  console.log(
    "Your owner session key is in .cache/local/owner.json. Copy its token into the console; keep this file private.",
  );
console.log(
  "Session credentials are stored in protected, Git-ignored files. Restarting replaces them.",
);
console.log(
  "To connect Codex, run: codex mcp add openlaunch -- node " +
    fileURLToPath(new URL("local-mcp.mjs", import.meta.url)),
);
const child = spawn(
  process.execPath,
  ["--import", "tsx", "apps/local/src/server.ts"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENLAUNCH_OWNER_TOKEN: owner,
      OPENLAUNCH_AGENT_TOKEN: agent,
      OPENLAUNCH_DEVICE_CREDENTIAL_KEYS: deviceCredentialKeys,
    },
  },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => {
  console.error("Could not start the bridge.");
  process.exit(1);
});
