# integrations.sh publishing

The site build composes discovery from the real device contract, MCP server
identity, CLI installer and existing plugin skill. Blume's read-only docs API
and MCP remain separate surfaces. No credentials, workspace records, device
identifiers or function grants appear in public discovery.

`apps/site/scripts/discovery.mjs` runs after Blume generates its artifacts:

- `/openapi.json` is the canonical device/owner/setup API contract.
  `/device-api.json` remains equivalent. `/docs-openapi.json` retains Blume's
  public documentation API contract.
- `/.well-known/integrations.json` is the inline v3 declaration of five surfaces:
  device API, device MCP, `ol`, docs API and docs MCP. API-token and OAuth access
  are alternatives; only agent API tokens authenticate `ol`.
- `/.well-known/mcp/server-card.json` describes authenticated device MCP at `/mcp`.
  `/.well-known/mcp/docs-server-card.json` describes public `/docs-mcp`.
- `/.well-known/api-catalog` uses RFC 9727 Linkset media type and a HEAD Link
  header. OAuth protected-resource metadata remains served by the device bridge.
- Skill discovery includes Blume's documentation skill and the exact existing
  `openlaunch-device-control` plugin skill with SHA-256 digests.
- Blume's AI catalogs, readability manifest and `llms.txt` preserve correct docs
  pointers and also link the device surfaces.

Authentication still requires owner approval of each device function. OAuth
scopes are access ceilings, not device grants. Setup and device credentials do
not authenticate agents. A2A and GraphQL are not implemented and are not declared.
`ol` uses the hosted installer; there is no invented public npm registry package.

Run `npm run build:site` and `npm run check:site` to validate the complete artifact.
The declaration validator uses an upstream-derived, pinned JSON Schema fixture
without adding a production dependency. CI deploys only after all required jobs
pass, then `python3 scripts/verify-hosted.py` checks the exact deployed commit,
discovery response headers, OAuth wiring, docs compatibility and skill hashes.

After an approved production deployment, open
<https://integrations.sh/openlaunch.dev/> and select **Map integration surface**.
Inspect the stored listing for all five declared surfaces, their auth alternatives,
canonical endpoints, install instructions and granted-function constraints.
The read-only detector at <https://integrations.sh/api/openlaunch.dev/detect>
must recognize the owner declaration and the real device API/MCP. Mapping writes
the registry listing; it does not create tokens, enroll devices or grant functions.
Repeat mapping after changing public discovery, and check the listing rather than
assuming that hosting files automatically refreshes it.

Publishing requirements: <https://integrations.sh/publishing/>.
