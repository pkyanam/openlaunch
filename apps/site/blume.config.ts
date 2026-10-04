import { defineConfig } from "blume";
import { node } from "blume/deploy";
export default defineConfig({
  title: "openlaunch",
  description:
    "Connect your agents to explicitly approved device capabilities with openlaunch, a modular provider-neutral bridge.",
  logo: { image: "/icon.png", text: "openlaunch", href: "/" },
  basePath: "/docs",
  theme: {
    accent: { light: "#111111", dark: "#eeeeee" },
    radius: "md",
    mode: "system",
  },
  github: { owner: "pkyanam", repo: "openlaunch", dir: "apps/site" },
  deployment: node({
    site: process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev",
  }),
  agents: {
    llmsTxt: true,
    skillMd: true,
    mcp: { enabled: true, route: "/docs-mcp", name: "openlaunch docs" },
  },
  export: { pdf: true, epub: true },
  narration: true,
  footer: {
    links: [
      { label: "Setup", href: "/docs/setup" },
      { label: "Project status", href: "/docs/status" },
    ],
  },
});
