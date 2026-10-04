import { copyFileSync, mkdirSync } from "node:fs";
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
