import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hub, emptyState, Fault } from "../../../packages/core/src/index.ts";
import { handle } from "../../../packages/http/src/index.ts";
import { publicOrigin, requestOrigin } from "./origin.ts";
const port = Number(process.env.PORT ?? 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const externalOrigin = publicOrigin(process.env.OPENLAUNCH_PUBLIC_ORIGIN);
const ownerToken = process.env.OPENLAUNCH_OWNER_TOKEN,
  agentToken = process.env.OPENLAUNCH_AGENT_TOKEN;
if (
  !ownerToken ||
  !agentToken ||
  ownerToken.length < 32 ||
  agentToken.length < 32 ||
  ownerToken === agentToken
)
  throw new Error(
    "Provide distinct owner/agent tokens of at least 32 characters in the process environment. Local server binds loopback only.",
  );
const dir = resolve(process.env.OPENLAUNCH_STATE_DIR ?? ".cache/local");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(resolve(dir, "state.sqlite"));
db.exec(
  "PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS hub(id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)",
);
let queue = Promise.resolve();
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const server = createServer((req, res) => {
  queue = queue
    .then(async () => {
      try {
        const bytes: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 16384) {
            res.writeHead(413).end();
            return;
          }
          bytes.push(chunk);
        }
        const host = req.headers.host ?? "";
        const origin = requestOrigin(host, port, externalOrigin);
        if (!origin) {
          res.writeHead(403).end();
          return;
        }
        const path = new URL(req.url ?? "/", "http://" + host).pathname;
        if (
          req.method === "GET" &&
          (path === "/" || path.startsWith("/assets/"))
        ) {
          const root = resolve("apps/web/dist");
          const file = resolve(root, path === "/" ? "index.html" : "." + path);
          if (file.startsWith(root + "/") && existsSync(file)) {
            res
              .writeHead(200, {
                "content-type": file.endsWith(".js")
                  ? "text/javascript"
                  : file.endsWith(".css")
                    ? "text/css"
                    : "text/html",
                "x-content-type-options": "nosniff",
              })
              .end(readFileSync(file));
            return;
          }
          res.writeHead(404).end();
          return;
        }
        const request = new Request(origin + (req.url ?? "/"), {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(!["GET", "HEAD"].includes(req.method ?? "GET")
            ? { body: Buffer.concat(bytes) }
            : {}),
        });
        const row = db.prepare("SELECT state FROM hub WHERE id=1").get() as
          { state: string } | undefined;
        const hub = new Hub(row ? JSON.parse(row.state) : emptyState());
        const response = await handle(request, hub, async (r) => {
          const token =
            r.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
          if (equal(token, ownerToken!)) return { id: "owner", owner: true };
          if (equal(token, agentToken!))
            return { id: "local-agent", owner: false };
          throw new Fault("unauthorized", 401, "Valid bearer required");
        });
        db.prepare(
          "INSERT INTO hub(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
        ).run(JSON.stringify(hub.state));
        response.headers.set("x-openlaunch-workspace", "0".repeat(64));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500).end('{"error":{"code":"internal"}}');
      }
    })
    .catch(() => {
      res.writeHead(500).end();
    });
});
server.requestTimeout = 10000;
server.headersTimeout = 10000;
server.maxHeadersCount = 64;
server.listen(port, "127.0.0.1", () =>
  console.log(
    "openlaunch local bridge listening on loopback; tokens are not logged",
  ),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () =>
    server.close(() => {
      db.close();
      process.exit(0);
    }),
  );
