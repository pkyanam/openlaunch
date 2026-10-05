import { installerManifest } from "./installers.mjs";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
// The website and GitHub backup use these same tracked installer sources.
mkdirSync("public/downloads", { recursive: true });
copyFileSync("../../scripts/setup.sh", "public/setup.sh");
copyFileSync("../../scripts/setup.py", "public/downloads/setup.py");
copyFileSync("../../scripts/install.sh", "public/install.sh");
copyFileSync("../../scripts/install-pi.sh", "public/install-pi.sh");
copyFileSync("../../scripts/setup-uno.sh", "public/setup-uno.sh");
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
copyFileSync(
  "../../scripts/provision-roomba.py",
  "public/downloads/provision-roomba.py",
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
