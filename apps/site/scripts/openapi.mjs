import { mkdir, writeFile } from "node:fs/promises";
import { buildOpenApi } from "../../../packages/http/src/contracts.ts";

const output = new URL("../public/device-api.json", import.meta.url);
const document = `${JSON.stringify(buildOpenApi(), null, 2)}\n`;
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(output, document);
