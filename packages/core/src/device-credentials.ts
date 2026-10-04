import type { DeviceCredentialDeriver } from "./index.ts";

/** Server-only keyring. Never serialize it into workspace state or device code. */
export function createDeviceCredentialDeriver(
  serialized: string | undefined,
  currentVersion = "v1",
): DeviceCredentialDeriver | undefined {
  if (!serialized || serialized.length > 1024) return undefined;
  let keys: Record<string, string>;
  try {
    keys = JSON.parse(serialized);
    if (!keys || Array.isArray(keys) || typeof keys !== "object")
      return undefined;
    const entries = Object.entries(keys);
    if (
      !entries.length ||
      entries.length > 4 ||
      entries.some(
        ([version, key]) =>
          !/^[a-z0-9]{1,16}$/.test(version) ||
          typeof key !== "string" ||
          !/^[a-f0-9]{64}$/.test(key),
      )
    )
      return undefined;
    if (!Object.hasOwn(keys, currentVersion)) return undefined;
  } catch {
    return undefined;
  }
  return {
    keyVersion: currentVersion,
    async derive(version, context) {
      if (!Object.hasOwn(keys, version))
        throw new Error("Credential key version unavailable");
      const bytes = Uint8Array.from(keys[version]!.match(/.{2}/g)!, (pair) =>
        parseInt(pair, 16),
      );
      const key = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(context),
      );
      return Array.from(new Uint8Array(signature), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    },
  };
}
