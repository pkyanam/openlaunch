import { defineConfig } from "blume";
import { node } from "blume/deploy";
import { openapi } from "blume/reference";
export default defineConfig({
  title: "openlaunch",
  description:
    "Connect your agents to your hardware with openlaunch. Pair devices, manage permissions, and follow each command from request to result.",
  logo: { image: "/icon.png", text: "openlaunch", href: "/" },
  seo: { og: { logo: "/og-mark.svg" } },
  basePath: "/docs",
  theme: {
    accent: { light: "#111111", dark: "#eeeeee" },
    radius: "md",
    mode: "system",
  },
  github: { owner: "pkyanam", repo: "openlaunch", dir: "apps/site" },
  navigation: {
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "API", path: "/reference" },
      { label: "CLI", path: "/docs/cli" },
      { label: "Agents", path: "/docs/agents" },
    ],
    actions: [
      { label: "Updates", href: "https://www.openlaunch.dev/changelog" },
    ],
    cta: { label: "Console", href: "https://www.openlaunch.dev/console/" },
  },
  reference: [
    openapi({
      spec: "./public/device-api.json",
      route: "/reference",
      codeSamples: ["curl", "typescript", "python", "go"],
      playground: true,
      expandSchemas: false,
    }),
  ],
  variables: {
    "api-url": "https://www.openlaunch.dev",
    "mcp-url": "https://www.openlaunch.dev/mcp",
    "cli-install":
      "curl -fsSL https://www.openlaunch.dev/install-cli.sh | bash",
  },
  search: {
    indexing: { includeCodeBlocks: true },
    popular: [
      { label: "Get started", href: "/docs/setup" },
      { label: "Install ol", href: "/docs/cli" },
      { label: "API reference", href: "/reference" },
    ],
  },
  changelog: {
    title: "openlaunch updates",
    description:
      "Follow changes to openlaunch's device API, agent connections, installers and firmware, with links to verified software commits.",
  },
  deployment: node({
    site: process.env.OPENLAUNCH_SITE_ORIGIN || "https://www.openlaunch.dev",
  }),
  agents: {
    agentReadability: true,
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
      { label: "Terms", href: "/docs/terms" },
      { label: "Privacy", href: "/docs/privacy" },
    ],
  },
});
