# AgentID sign-in

AgentID uses Clerk's official `oauth_agentid` connection. The console renders the providers enabled for its Clerk instance with the supported `SignIn` component; it does not hard-code a Google-only button or implement a second token verifier. Existing Google sign-in and legacy `/console/?sso=callback` redirects remain supported.

## Configure

From the project root, run:

```sh
npm run setup:agentid
```

This runs the pinned AgentID 0.9.0 initializer for Clerk production. Choose the existing **openlaunch** application. Production uses `https://clerk.openlaunch.dev/v1/oauth_callback`. Choose standard identity scopes (`openid email profile`); openlaunch does not use AgentID owner claims to map workspaces. The workspace and membership identity is a SHA-256 hash of the verified Clerk issuer and Clerk subject, computed from what Clerk already verified; the service never retrieves AgentID owner claims or email bindings from upstream. Approve registration in the browser and allow its loopback callback to return to the CLI. For a separate development instance, run the initializer directly and select development; do not reuse production credentials.

The initializer stores the client ID, client secret and project binding in ignored `.env.local` with restricted permissions, and configures Clerk. Do not copy these values into source, a frontend environment variable, device firmware, CI logs, or chat. Clerk stores the provider secret; the device service continues to use its existing Clerk configuration. Registration is idempotent when the same bound credentials are present. Do not use `--force` for a normal retry.

New hosted connections start disabled. Once the client, callback and provider configuration have been checked, enable sign-in for that instance:

```sh
npx @agentmail/agentid-cli@0.9.0 init --enable-sso
```

This reuses the locally bound registration. Select the same application and environment. Never create or enable a production connection for an unrelated application.

AgentID agents must also be able to complete first-time sign-up. Clerk's **Protect → Rules → Bot sign-up protection** can challenge agents with Turnstile even when the provider doctor passes. For the current production integration, sign-up CAPTCHA is disabled through Clerk's supported `auth_attack_protection.bot_protection.captcha_enabled` setting, with owner authorization. This is an instance-wide setting and also affects Google sign-ups; other attack-protection settings remain configured. The console still requires a verified identity, and device access still requires its own workspace credentials and grants.

In the AgentID application's settings, set **Login URL** to `https://www.openlaunch.dev/console/`. The public sign-in page offers AgentID. Set the **Initiate login URL** to `https://www.openlaunch.dev/console/?agentid=1`, the console entrypoint for AgentID sign-ins used by `ol login --agentid` and AgentID-initiated logins. Keep the registered callback at `https://clerk.openlaunch.dev/v1/oauth_callback`. Placeholder text such as `app.example.com` is not a configured openlaunch URL. The AgentID **Needs setup** status requires a completed test sign-in; provider configuration alone is not that test.

## Verify

```sh
npm run check:agentid
```

Select **openlaunch** when asked. The explicit production option is needed because this monorepo is not Next.js; bare noninteractive `doctor --json` cannot detect the provider at its root. Check that the production console offers Google and AgentID. Follow AgentID through its waiting/enrollment page and back to the console; verify a real Clerk session and the correct workspace. Check a fresh browser and a returning AgentID session, cancel/retry, Google sign-in, and the mobile layout. Provider configuration and a displayed button are not proof of a completed AgentID login.

Also check the sign-up protection setting above. AgentID CLI 0.9.0's doctor validates the provider connection but does not report whether Clerk's sign-up CAPTCHA can block new agents.

If registration was approved but the CLI is waiting, finish **Return to CLI** in the browser on the same Mac. Do not register a replacement client just because a callback has not arrived. If credentials were stored but provider configuration failed, rerun the same initializer to recover.

## Authorization boundaries

AgentID verifies an identity. It does not authorize device control in a human owner's workspace. A different Clerk subject has its own isolated workspace; `owner_email` is never an account-linking or authorization key, and no sign-in merges workspaces by email.

Agent requests to the existing device workspace still use an owner-authorized OAuth connection or an `ol_agent_` API connection, with a live per-function grant. The MCP endpoint rejects console sessions and raw AgentID tokens. An `ol_sdk_` setup token only attaches devices; devices retain their own child credentials. Sign-in creates no device grant or agent API credential and changes no existing pairing.

A workspace owner can admit an AgentID agent as a named member through a one-time workspace invitation bound to that exact verified Clerk subject. See [agent workspace onboarding](AGENT-ONBOARDING.md) for roles, the all-functions default with opt-out exclusions, the `ol login --agentid` browser-backed exchange, and revocation.

Disable the AgentID connection in Clerk to stop new AgentID sign-ins. Existing Clerk sessions and issued openlaunch credentials have their own lifetimes and revocation controls; disabling the upstream provider alone is not full access revocation.

Reference: [AgentID CLI](https://www.agentid.com/docs/cli), [Clerk integration](https://www.agentid.com/docs/clerk), and [integration reference](https://www.agentid.com/llms-full.txt). Version 0.9.0 installs the official connection; older custom-provider examples use a different strategy and should not replace it.
