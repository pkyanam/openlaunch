import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
export function installerManifest(downloadDirectory, origin) {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const digest = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
  return {
    commit,
    installers: [
      "setup.sh",
      "setup.py",
      "install.sh",
      "install-pi.sh",
      "setup-uno.sh",
      "provision-uno.py",
      "provision-roomba.py",
      "provision-esp32.py",
    ].map((filename) => ({
      url: `${origin}/${filename.endsWith(".py") ? "downloads/" : ""}${filename}`,
      sha256: digest(join(root, "scripts", filename)),
      backup: `https://raw.githubusercontent.com/pkyanam/openlaunch/${commit}/scripts/${filename}`,
    })),
    embeddedSdk: {
      url: `${origin}/downloads/openlaunch-esp32.zip`,
      sha256: digest(join(downloadDirectory, "openlaunch-esp32.zip")),
      source: `https://github.com/pkyanam/openlaunch/tree/${commit}/packages/embedded-sdk`,
    },
    sdk: {
      url: `${origin}/downloads/openlaunch-sdk.tgz?commit=${commit}`,
      sha256: digest(join(downloadDirectory, "openlaunch-sdk.tgz")),
      source: `https://github.com/pkyanam/openlaunch/tree/${commit}/packages/sdk`,
    },
  };
}
