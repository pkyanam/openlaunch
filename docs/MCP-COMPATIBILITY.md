# MCP compatibility

The device `/mcp`, public `/docs-mcp` and local stdio adapter support the
2026-07-28 per-request protocol. Earlier clients retain their SDK-backed
initialize/initialized flow. The pinned SDK currently supports legacy versions;
the newer envelope is implemented separately over the same device tool registry.

The normative source is https://modelcontextprotocol.io/specification/2026-07-28.
The dated upstream JSON Schema and license notice are preserved under
`tests/fixtures/mcp-2026`. Tests validate discovery, tool catalogs, action results
and errors against that schema; documentation checks additionally validate page
resources against it. This is a tested compatibility claim, not an external
certification.

Implemented requirements include:

- Independent per-request metadata; no modern initialization or session required.
- `server/discover`, supported-version negotiation and `resultType` envelopes.
- Required protocol, method and name headers; case-sensitive values and exact
  UTF-8/Base64 name decoding, including malformed-header rejection.
- JSON Schema 2020-12 inputs, bounded argument validation and private, zero-TTL
  permission-dependent catalogs. External schema references are not fetched.
- Origin checks, authenticated device tools, no-store responses and bounded
  request bodies. JSON responses are used; clients must advertise JSON and SSE.
- HTTP 400 header/version errors, HTTP 404 unsupported methods and HTTP 405
  GET/DELETE with `Allow: POST`; unreadable JSON-RPC IDs are omitted.
- OAuth protected-resource metadata, minimum read scopes and an actionable
  `insufficient_scope` challenge for write calls.
- Owner-managed OAuth registration with exact HTTPS/loopback callbacks, enforced
  PKCE and consent, workspace admission, one-time secrets and separate function
  grants. Provider errors never reflect response bodies or backend credentials.

Device capabilities advertise tools. Documentation capabilities advertise tools
and resources. Prompts, sampling, elicitation, subscriptions, resumable SSE and
extensions are optional and are not advertised. Application action receipts are
explicit identifiers used with `get_action`; they are not protocol tasks.

Verification covers all 13 Roomba functions using a software fixture, exact
retries, live grants, scope ceilings, expiry across reload, connection revocation,
SQLite persistence, local stdio forwarding, and legacy clients. These checks do
not verify physical robot operation or a live login from Executor. The owner
must register the desired client in Connections, connect it in its MCP host,
and separately approve device-function grants.
