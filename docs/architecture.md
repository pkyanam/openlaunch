# Foundation

The user's agent calls authenticated MCP tools. The cloud relay verifies ownership and capability grants before dispatching a bounded command to a device-owned outbound connection. Results are correlated by action id; disconnects can leave outcomes unknown. No exactly-once physical execution guarantee is made.

Device enrollment, per-device credentials, upstream sign-in, and agent OAuth grants are separate trust boundaries. Cloudflare is a trusted relay; TLS is not a claim of end-to-end encryption from the host to the device.

Cloud: TypeScript Workers, React static assets, Durable Objects with SQLite-backed action state and hibernating WebSockets, D1 metadata, R2 artifacts. Pi: Go + systemd. Uno R4 WiFi: Arduino C++ on RA4M1 using supported connectivity firmware. Provider adapters: MCP/API/CLI first; ChatGPT/Codex conformance first, other harnesses later.
