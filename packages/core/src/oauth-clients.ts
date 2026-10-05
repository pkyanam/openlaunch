import { z } from "zod";

// Redirects are registered, never fetched by openlaunch. Exact HTTPS callbacks
// and literal loopback HTTP callbacks support hosted and local OAuth clients.
const redirect = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        value === url.href &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !value.includes("*") &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  }, "Use an exact HTTPS callback URL, or HTTP on a loopback host");
export const oauthClientConfig = z
  .object({
    name: z.string().trim().min(1).max(64),
    redirectUris: z
      .array(redirect)
      .min(1)
      .max(8)
      .refine(
        (uris) => new Set(uris).size === uris.length,
        "Duplicate callback URL",
      ),
    public: z.boolean().default(true),
    access: z.enum(["read", "act"]).default("read"),
  })
  .strict();
export type OAuthClientConfig = z.infer<typeof oauthClientConfig>;
export type OAuthClientMetadata = {
  applicationId: string;
  clientId: string;
  redirectUris: string[];
  public: boolean;
};
export interface OAuthClientProvider {
  create(
    config: OAuthClientConfig,
  ): Promise<OAuthClientMetadata & { clientSecret?: string }>;
  delete(applicationId: string): Promise<void>;
}
