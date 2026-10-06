import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import { buildOpenApi } from "../packages/http/src/contracts.ts";
import { serverInfo } from "../packages/mcp/src/index.ts";

const root = new URL("../apps/site/dist/client/", import.meta.url);
const origin = "https://www.openlaunch.dev";
const read = (path) => readFile(new URL(path, root));
const json = async (path) => JSON.parse(await read(path));
const declaration = await json(".well-known/integrations.json");
const schema = JSON.parse(
  await readFile(
    new URL(
      "../tests/fixtures/integrations/owner-declaration.schema.json",
      import.meta.url,
    ),
  ),
);
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(
  schema,
);
assert(validate(declaration), JSON.stringify(validate.errors));
assert.equal(new Set(declaration.surfaces.map((s) => s.slug)).size, 5);
assert.deepEqual(declaration.surfaces.map((s) => s.type).sort(), [
  "cli",
  "http",
  "http",
  "mcp",
  "mcp",
]);
const basis = {
  via: "declared",
  source: `${origin}/.well-known/integrations.json`,
};
for (const surface of declaration.surfaces) {
  assert.deepEqual(surface.basis, basis);
  if (surface.auth.status === "none")
    assert.deepEqual(surface.auth.basis, basis);
  for (const entry of surface.auth.entries ?? []) {
    assert.deepEqual(entry.basis, basis);
    assert.equal(
      entry.use.length,
      1,
      "API token and OAuth are alternatives, not simultaneous credentials",
    );
    assert(
      declaration.credentials[entry.use[0].id],
      "credential reference must resolve",
    );
  }
  if (surface.spec) await read(new URL(surface.spec).pathname.slice(1));
  await read(new URL(surface.docs).pathname.slice(1) + ".md");
}
const bySlug = Object.fromEntries(declaration.surfaces.map((s) => [s.slug, s]));
for (const slug of ["openlaunch-api", "openlaunch-mcp"]) {
  assert.equal(bySlug[slug].auth.status, "required");
  assert.deepEqual(
    bySlug[slug].auth.entries.map((e) => e.use[0].id),
    ["openlaunch-agent-token", "openlaunch-oauth"],
  );
}
for (const slug of ["openlaunch-docs-api", "openlaunch-docs-mcp"])
  assert.equal(bySlug[slug].auth.status, "none");
assert.deepEqual(bySlug["openlaunch-cli"].auth.entries[0].use[0].mechanics, {
  source: "cli",
  command: "ol login",
  env: ["OPENLAUNCH_AGENT_TOKEN"],
});
assert.equal(
  bySlug["openlaunch-cli"].packages,
  undefined,
  "do not advertise a registry package we haven't published",
);
const contract = await json("openapi.json");
assert.deepEqual(contract, buildOpenApi());
assert.deepEqual(contract, await json("device-api.json"));
assert.deepEqual(contract.paths["/mcp"].post.security, [
  { AgentAuth: [] },
  { OAuthAuth: [] },
]);
assert.deepEqual(contract.paths["/v1/sdk/devices"].post.security, [
  { SetupAuth: [] },
]);
assert.deepEqual(contract.paths["/v1/grants"].post.security, [
  { OwnerAuth: [] },
]);
const docsContract = await json("docs-openapi.json");
assert(docsContract.paths["/api/docs/pages.json"]);
assert(!docsContract.paths["/v1/devices"], "docs API must remain separate");
const card = await json(".well-known/mcp/server-card.json");
assert.equal(card.url, bySlug["openlaunch-mcp"].url);
assert.deepEqual(card.serverInfo, serverInfo);
assert.deepEqual(card.capabilities, { tools: {} });
const cloudConfig = await readFile(
  new URL("../apps/cloud/cloudflare.config.ts", import.meta.url),
  "utf8",
);
assert(
  cloudConfig.includes(
    `CLERK_ISSUER: bindings.text("${card.authentication.authorization_server}")`,
  ),
  "card must use the deployed issuer",
);
const docsCard = await json(".well-known/mcp/docs-server-card.json");
assert.equal(docsCard.url, bySlug["openlaunch-docs-mcp"].url);
assert(docsCard.tools.every((tool) => tool.annotations.readOnlyHint));
assert.deepEqual(
  (await json(".well-known/mcp.json")).servers.map((s) => s.url).sort(),
  [card.url, docsCard.url].sort(),
);
const catalog = await json(".well-known/api-catalog");
const endpoints = catalog.linkset[0].item.map((item) => item.href).sort();
assert.deepEqual(
  endpoints,
  declaration.surfaces
    .filter((s) => s.type !== "cli")
    .map((s) => s.url ?? `${origin}/api/docs`)
    .sort(),
);
for (const context of catalog.linkset.slice(1)) {
  assert(endpoints.includes(context.anchor));
  for (const link of context["service-desc"])
    await read(new URL(link.href).pathname.slice(1));
}
const skills = await json(".well-known/agent-skills/index.json");
assert.deepEqual(skills.skills.map((s) => s.name).sort(), [
  "openlaunch",
  "openlaunch-device-control",
]);
for (const skill of skills.skills) {
  const contents = await read(new URL(skill.url, origin).pathname.slice(1));
  assert.equal(
    skill.digest,
    `sha256:${createHash("sha256").update(contents).digest("hex")}`,
  );
  if (skill.name === "openlaunch-device-control")
    assert.deepEqual(
      contents,
      await readFile(
        new URL(
          "../integrations/plugin/openlaunch/skills/openlaunch-device-control/SKILL.md",
          import.meta.url,
        ),
      ),
    );
}
for (const path of [".well-known/ai-catalog.json", ".well-known/ard.json"]) {
  const catalog = await json(path);
  const docsEntry = catalog.entries.find(
    (e) => e.displayName === "openlaunch docs API",
  );
  assert.equal(docsEntry.url, `${origin}/docs-openapi.json`);
  assert.equal(
    catalog.entries.find((e) => e.displayName === "openlaunch docs").url,
    `${origin}/.well-known/mcp/docs-server-card.json`,
  );
  for (const entry of catalog.entries.filter((e) => e.type !== "text/html"))
    await read(new URL(entry.url).pathname.slice(1));
}
assert.equal(
  (await json("agent-readability.json")).artifacts.api.openapi,
  `${origin}/docs-openapi.json`,
);
const llms = (await read("llms.txt")).toString();
assert(llms.includes(`${origin}/docs-openapi.json`));
assert(llms.includes(`${origin}/openapi.json`));
const headers = (await read("_headers")).toString();
assert(
  headers.includes(
    'Content-Type: application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"',
  ),
);
assert(
  headers.includes(
    `Link: <${origin}/.well-known/api-catalog>; rel="api-catalog"`,
  ),
);
console.log(
  "PASS: discovery schema, five surfaces, separate credential purposes, docs compatibility, skill digests and catalog",
);
