import { defineConfig } from "blume";
export default defineConfig({
  title: "openlaunch",
  description:
    "Connect your agents to explicitly approved device capabilities with openlaunch, a modular provider-neutral bridge. Explore the local developer alpha.",
  logo: { image: "/icon.png", text: "openlaunch", href: "/" },
  basePath: "/docs",
  theme: {
    accent: { light: "#111111", dark: "#eeeeee" },
    radius: "md",
    mode: "system",
  },
  github: { owner: "pkyanam", repo: "openlaunch", dir: "apps/site" },
  deployment: {
    site: process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev",
  },
  agents: { llmsTxt: true, mcp: { enabled: false } },
  footer: {
    links: [
      { label: "Setup", href: "/docs/setup" },
      { label: "Project status", href: "/docs/status" },
    ],
  },
});
