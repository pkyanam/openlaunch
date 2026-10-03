import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "openlaunch-dev",
    compatibilityDate: "2026-10-01",
    entrypoint,
    exports: { WorkspaceHub: exports.durableObject({ storage: "sqlite" }) },
    env: {
      HUBS: bindings.durableObject({
        worker: "openlaunch-dev",
        exportName: "WorkspaceHub",
      }),
    },
  },
});
