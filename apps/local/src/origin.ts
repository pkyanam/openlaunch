/** Explicit HTTPS reverse-proxy origin for real-board development. Never trust forwarded headers. */
export function publicOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw new Error("OPENLAUNCH_PUBLIC_ORIGIN must be a bare HTTPS origin");
  return u.origin;
}
export function requestOrigin(
  host: string,
  port: number,
  external?: string,
): string | undefined {
  const local = `127.0.0.1:${port}`;
  if (host === local) return external ?? `http://${local}`;
  if (external && host === new URL(external).host) return external;
  return undefined;
}
