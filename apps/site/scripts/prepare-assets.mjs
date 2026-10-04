import { copyFileSync, mkdirSync } from "node:fs";
// The website and GitHub backup use these same tracked installer sources.
mkdirSync("public/downloads", { recursive: true });
copyFileSync("../../scripts/install.sh", "public/install.sh");
copyFileSync(
  "../../scripts/provision-uno.py",
  "public/downloads/provision-uno.py",
);
