import { useState } from "react";

export type OAuthConnection = {
  id: string;
  principal: string;
  name: string;
  access: "read" | "act";
  oauth: { clientId: string; redirectUris: string[]; public: boolean };
};
type Props = {
  available: boolean;
  clients: OAuthConnection[];
  api: (path: string, method?: string, data?: unknown) => Promise<any>;
  run: (fn: () => Promise<void>) => unknown;
  busy: boolean;
  onRefresh: (clients: OAuthConnection[]) => void;
  refreshGrants: () => Promise<void>;
  notify: (message: string) => void;
  grantAccess: (principal: string) => void;
  confirm: (message: string) => Promise<boolean>;
};
export function OAuthClients({
  available,
  clients,
  api,
  run,
  busy,
  onRefresh,
  refreshGrants,
  notify,
  grantAccess,
  confirm,
}: Props) {
  const [name, setName] = useState("");
  const [callbacks, setCallbacks] = useState("");
  const [isPublic, setPublic] = useState(true);
  const [access, setAccess] = useState<"read" | "act">("read");
  const [created, setCreated] = useState<
    (OAuthConnection & { clientSecret?: string }) | null
  >(null);
  const [showSecret, setShowSecret] = useState(false);
  const load = async () => {
    const [registered] = await Promise.all([
      api("/v1/oauth-clients"),
      refreshGrants(),
    ]);
    onRefresh(registered.clients);
  };
  return (
    <div className="connection-method oauth-clients">
      <p>
        Register an OAuth client for Executor, your own application, or another
        MCP host. Use the callback URL supplied by that application. All clients
        use PKCE and an OAuth consent screen.
      </p>
      <p>
        OAuth sign-in does not grant device access. Choose function grants
        separately on Devices.
      </p>
      {!available ? (
        <p role="status">
          OAuth client registration requires a configured hosted authorization
          provider. Agent API tokens remain available on local servers.
        </p>
      ) : (
        <>
          {!created && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(async () => {
                  const client = await api("/v1/oauth-clients", "POST", {
                    name,
                    redirectUris: callbacks
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                    public: isPublic,
                    access,
                  });
                  setCreated(client);
                  setShowSecret(false);
                  await load();
                  notify(
                    "OAuth client registered. Copy its details into your application, then grant device functions.",
                  );
                });
              }}
            >
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setName("Executor");
                    setCallbacks("https://v2.executor.sh/api/oauth/callback");
                    setPublic(true);
                  }}
                >
                  Use Executor settings
                </button>
              </div>
              <label>
                Application name
                <input
                  value={name}
                  maxLength={64}
                  required
                  placeholder="My application"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Callback URLs
                <textarea
                  value={callbacks}
                  required
                  rows={3}
                  placeholder="https://your-app.example/oauth/callback"
                  onChange={(event) => setCallbacks(event.target.value)}
                />
              </label>
              <p className="muted">
                One exact URL per line. HTTPS, or HTTP on a loopback host for a
                local client.
              </p>
              <label>
                Client type
                <select
                  value={isPublic ? "public" : "confidential"}
                  onChange={(event) =>
                    setPublic(event.target.value === "public")
                  }
                >
                  <option value="public">
                    Public client · PKCE, no secret
                  </option>
                  <option value="confidential">
                    Confidential client · PKCE and secret
                  </option>
                </select>
              </label>
              <label>
                Allowed access
                <select
                  value={access}
                  onChange={(event) =>
                    setAccess(event.target.value as "read" | "act")
                  }
                >
                  <option value="read">Read granted functions</option>
                  <option value="act">Read and invoke granted functions</option>
                </select>
              </label>
              <button disabled={busy}>Register OAuth client</button>
            </form>
          )}
          {created && (
            <section
              className="oauth-client-created"
              aria-label="New OAuth client"
            >
              <h3>{created.name} is registered</h3>
              <label>
                Client ID
                <input readOnly value={created.oauth.clientId} />
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(created.oauth.clientId);
                    notify("OAuth client ID copied.");
                  })
                }
              >
                Copy client ID
              </button>
              {created.clientSecret && (
                <>
                  <label>
                    Client secret · shown once
                    <input
                      type={showSecret ? "text" : "password"}
                      readOnly
                      autoComplete="off"
                      value={created.clientSecret}
                    />
                  </label>
                  <div className="row">
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setShowSecret(!showSecret)}
                    >
                      {showSecret ? "Hide secret" : "Show secret"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(
                            created.clientSecret!,
                          );
                          notify("OAuth client secret copied.");
                        })
                      }
                    >
                      Copy client secret
                    </button>
                  </div>
                  <p>
                    Copy the secret before leaving this tab. openlaunch does not
                    store it or show it again.
                  </p>
                </>
              )}
              {!created.clientSecret && (
                <p>
                  This public client uses PKCE. Leave the optional client secret
                  empty in your MCP host.
                </p>
              )}
              <p>
                MCP URL: <code>{window.location.origin}/mcp</code>
              </p>
              <p>
                Requested scopes:{" "}
                <code>
                  openlaunch:read
                  {created.access === "act" ? " openlaunch:act" : ""}
                </code>
                . Hosts may also request openid, profile, email and
                offline_access.
              </p>
              <div className="row">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setCreated(null);
                    setName("");
                    setCallbacks("");
                  }}
                >
                  Done
                </button>
              </div>
            </section>
          )}
        </>
      )}
      <div className="connection-list">
        <h3>Registered OAuth clients</h3>
        {clients.length === 0 ? (
          <p>No custom OAuth clients registered.</p>
        ) : (
          clients.map((client) => (
            <article className="oauth-client-card" key={client.id}>
              <h4>{client.name}</h4>
              <p>
                {client.oauth.public ? "Public · PKCE" : "Confidential · PKCE"}{" "}
                · {client.access === "act" ? "Read and act" : "Read only"}
              </p>
              <label>
                Client ID
                <input readOnly value={client.oauth.clientId} />
              </label>
              <p>
                Callbacks:{" "}
                {client.oauth.redirectUris.map((uri) => (
                  <code key={uri}>{uri}</code>
                ))}
              </p>
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCreated(null);
                    grantAccess(client.principal);
                  }}
                >
                  Configure function access
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      if (
                        !(await confirm(
                          `Revoke OAuth client ${client.name}? Its grants and undispatched commands will be removed.`,
                        ))
                      )
                        return;
                      const result = await api(
                        `/v1/oauth-clients/${client.id}/revoke`,
                        "POST",
                      );
                      if (created?.id === client.id) setCreated(null);
                      await load();
                      notify(
                        result.providerCleanupPending
                          ? "Client access revoked. Provider cleanup is pending; contact the server operator."
                          : "OAuth client and its function grants revoked.",
                      );
                    })
                  }
                >
                  Revoke client
                </button>
              </div>
              <p className="muted">
                To change callback URLs or the scope ceiling, revoke this client
                and register its replacement.
              </p>
            </article>
          ))
        )}
      </div>
    </div>
  );
}
