import { Fault } from "../../../packages/core/src/index.ts";
import type {
  OAuthClientProvider,
  OAuthClientConfig,
} from "../../../packages/core/src/oauth-clients.ts";

// Fixed provider origin: owner-supplied callbacks never become fetch targets.
// Raw BAPI is necessary because the pinned SDK omits the PKCE/consent flags.
export function clerkOAuthClients(
  secretKey: string,
  fetcher: typeof fetch = fetch,
): OAuthClientProvider {
  const call = async (path: string, method: string, data?: unknown) => {
    const response = await fetcher(
      `https://api.clerk.com/v1/oauth_applications${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${secretKey}`,
          "content-type": "application/json",
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(10000),
      },
    );
    // Never reflect a provider body: it can contain credentials or private data.
    if (!response.ok && !(method === "DELETE" && response.status === 404))
      throw new Fault(
        "oauth_provider",
        502,
        "OAuth registration provider could not complete the request",
      );
    return method === "DELETE"
      ? undefined
      : ((await response.json()) as Record<string, unknown>);
  };
  return {
    async create(config: OAuthClientConfig) {
      const scopes = `openid profile email offline_access openlaunch:read${config.access === "act" ? " openlaunch:act" : ""}`;
      const data = (await call("", "POST", {
        name: config.name,
        redirect_uris: config.redirectUris,
        public: config.public,
        consent_screen_enabled: true,
        pkce_required: true,
        scopes,
      }))!;
      if (
        typeof data.id !== "string" ||
        typeof data.client_id !== "string" ||
        data.pkce_required !== true ||
        data.consent_screen_enabled !== true ||
        data.public !== config.public ||
        typeof data.scopes !== "string" ||
        [...new Set(data.scopes.trim().split(/\s+/))].sort().join(" ") !==
          scopes.split(" ").sort().join(" ") ||
        (!config.public &&
          (typeof data.client_secret !== "string" || !data.client_secret))
      ) {
        // Reject unexpected provider policy rather than admitting an unsafe app.
        if (typeof data.id === "string" && /^[a-zA-Z0-9_-]+$/.test(data.id))
          await call(`/${data.id}`, "DELETE").catch(() => undefined);
        throw new Fault(
          "oauth_provider",
          502,
          "OAuth provider returned an invalid client policy",
        );
      }
      return {
        applicationId: data.id,
        clientId: data.client_id,
        redirectUris: config.redirectUris,
        public: config.public,
        ...(!config.public
          ? { clientSecret: data.client_secret as string }
          : {}),
      };
    },
    async delete(id: string) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id))
        throw new Fault("invalid", 400, "Invalid OAuth application");
      await call(`/${id}`, "DELETE");
    },
  };
}
