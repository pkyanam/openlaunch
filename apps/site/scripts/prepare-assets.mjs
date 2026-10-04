import { installerManifest } from "./installers.mjs";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// The website and GitHub backup use these same tracked installer sources.
mkdirSync("public/downloads", { recursive: true });
copyFileSync("../../scripts/install.sh", "public/install.sh");
copyFileSync("../../scripts/install-pi.sh", "public/install-pi.sh");
execFileSync(
  process.execPath,
  [
    "../../scripts/package-plugin.mjs",
    "apps/site/public/downloads/openlaunch-plugin.zip",
  ],
  { stdio: "inherit" },
);
execFileSync(process.execPath, ["../../scripts/package-sdk.mjs"], {
  stdio: "inherit",
});
copyFileSync(
  "../../scripts/provision-uno.py",
  "public/downloads/provision-uno.py",
);

execFileSync(
  process.execPath,
  [
    "scripts/package-embedded-sdk.mjs",
    "--output",
    "apps/site/public/downloads/openlaunch-esp32.zip",
  ],
  { stdio: "inherit", cwd: "../.." },
);

copyFileSync(
  "../../scripts/provision-esp32.py",
  "public/downloads/provision-esp32.py",
);

writeFileSync(
  "public/downloads/installers.json",
  JSON.stringify(
    installerManifest(
      "public/downloads",
      process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev",
    ),
    null,
    2,
  ) + "\n",
);
