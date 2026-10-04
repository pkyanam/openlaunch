import { defineConfig } from "blume";
export default defineConfig({
  title: "openlaunch",
  description:
    "Connect your agents to explicitly approved device capabilities with openlaunch, a modular provider-neutral bridge. Explore the local developer alpha.",
  logo: { image: "/icon.svg", text: "openlaunch", href: "/" },
  basePath: "/docs",
  theme: { accent: "teal", radius: "md", mode: "system" },
  banner: "Developer alpha · hardware acceptance and hosted onboarding pending",
  github: { owner: "pkyanam", repo: "openlaunch" },
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
