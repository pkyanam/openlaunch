import { bindings, defineConfig, exports } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };
export default defineConfig({
  worker: {
    name: "openlaunch-bridge",
    compatibilityDate: "2026-10-01",
    entrypoint,
    exports: { WorkspaceHub: exports.durableObject({ storage: "sqlite" }) },
    env: {
      HUBS: bindings.durableObject({
        worker: "openlaunch-bridge",
        exportName: "WorkspaceHub",
      }),
      CLERK_SECRET_KEY: bindings.secret(),
      DEVICE_CREDENTIAL_KEYS: bindings.secret(),
      DEVICE_CREDENTIAL_KEY_VERSION: bindings.text(
        process.env.DEVICE_CREDENTIAL_KEY_VERSION || "v1",
      ),
      CLERK_PUBLISHABLE_KEY: bindings.text(
        process.env.CLERK_PUBLISHABLE_KEY ?? "",
      ),
      CLERK_ISSUER: bindings.text("https://clerk.openlaunch.dev"),
      BUILD_COMMIT: bindings.text(
        process.env.OPENLAUNCH_BUILD_COMMIT ?? "development",
      ),
      API_ORIGIN: bindings.text("https://www.openlaunch.dev"),
      CLERK_AGENT_CLIENT_IDS: bindings.text(
        "https://chatgpt.com/oauth/client.json,https://chatgpt.com/oauth/codex/client.json",
      ),
      CONTROLS_ENABLED: bindings.text(
        process.env.OPENLAUNCH_CONTROLS_ENABLED ?? "false",
      ),
      REQUEST_LIMITER: bindings.rateLimit({
        namespace: "1",
        simple: { limit: 200, period: 60 },
      }),
    },
  },
});
