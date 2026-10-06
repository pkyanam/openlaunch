# Agent workspace onboarding

This document covers the ongoing agent onboarding feature: how a workspace owner admits an agent as a named member with a role and an access policy, how the agent signs in and uses the workspace, and how access is scoped, delegated and revoked. It complements [AgentID sign-in](AGENTID.md) (the upstream identity provider setup) and the public guides under `apps/site/docs`.

Workspace membership routes, the access-policy model, the identity directory, MCP management tools and the `ol login --agentid` exchange are implemented in the cloud service, core and SDK. Automated acceptance exercises invitation admission, PKCE login, setup credentials, software-adapter actions, exclusions after restart and revocation. A live sign-in test requires an enrolled AgentID inbox; software fixtures do not establish physical device results.

Live acceptance on October 6, 2026 completed AgentID sign-in through Clerk, PKCE CLI login, setup-token creation, software-adapter attachment, API/MCP/CLI action retry recovery, a returned result, policy exclusions and credential revocation. The enrolled agent also accepted an owner invitation, switched workspaces and obtained an operator CLI credential that discovered three devices and 45 functions without individual grants. Operator setup was denied; revoking membership immediately denied that CLI credential. Temporary device identities and credentials were revoked and private test credentials removed. These checks sent no commands to the owner's physical devices.

## Concepts

- **Workspace** — the isolated record set derived from the owner's verified Clerk identity. Devices, grants, connections and audit records live inside it.
- **Agent member** — a named membership bound to one exact verified identity: the SHA-256 hash of the Clerk issuer and the verified Clerk subject. The service derives this identifier from what Clerk verified; it never retrieves AgentID owner claims or email bindings. Membership is an admission record, not a credential: access always goes through a verified sign-in session or an identity-bound CLI credential issued by that sign-in.
- **Role** — `owner`, `administrator`, or `operator`.
- **Access policy** — per-member scope: a mode (`all` or `selected`), optional device and function exclusions, the role, and an optional expiry. All-functions mode covers devices and functions as they appear in the workspace, including newly attached devices and newly approved functions such as Home Assistant discoveries.

## Roles

| Role | Can do |
| --- | --- |
| Owner | Everything. Only the owner can delegate administration. |
| Administrator | Explicitly delegated by the owner. Onboards and manages agents (invites operators, lists members, revokes members) and performs workspace setup and management on the owner's behalf. Cannot invite another administrator or change their own membership. |
| Operator | Default role for invited agents. Runtime control of devices within their access policy. Cannot manage membership, invite, revoke, or lift their own exclusions. |

## Default access for new connections

New linked, API and OAuth connections default to **action access with all current and future workspace functions** — every device and function, including new devices and new functions (including Home Assistant linked devices), unless the owner adds exclusions. This is the opt-out model: the owner excludes specific devices or functions rather than approving each one.

Legacy behavior is retained:

- Existing connections keep their previously selected mode and stored grants.
- Read-only connections remain read-only; revocations already made are not undone.
- Broadening a legacy connection from selected functions to all functions requires an explicit owner choice; it never happens automatically.

## Exclusions

An owner or administrator can exclude specific devices or specific device functions from an all-functions policy. Excluded functions are denied even while the rest of the policy stays active, and a newly excluded function's queued actions are cancelled. Guarantees, enforced by the delegation chain:

- A member cannot lift its own exclusions.
- Child credentials cannot lift exclusions. A CLI credential gets its own all-functions policy with no local exclusions and points at the member's live policy via `delegatedFrom`; it never copies a parent snapshot. The chain enforces the parent's state live: exclusions from any level deny, a `selected` level at any depth requires that level's own active grant, and relaxing or tightening the parent — exclusions, role, expiry or revocation — takes immediate effect on children. Chains are bounded in depth; missing links, expired policies, revoked connections, cycles and over-deep chains fail closed.

## Onboarding flow

1. **Agent sign-in.** The agent completes AgentID sign-in through Clerk (see [AgentID setup](AGENTID.md)). Without an invitation this creates only the agent's own separate workspace — no device grant, no API credential, no access to the owner's devices.
2. **Invitation.** A workspace administrator (or the owner) invites the agent by name and role:
   `POST /v1/workspace/invitations` with `{ "name": "Test agent", "role": "operator" }`. The one-time invitation token uses the `ol_inv_` prefix, expires after 10 minutes by default (60 seconds to 1 hour configurable), and admits exactly one Clerk subject. Up to 50 pending invitations per workspace; up to 100 agent members.
3. **Accept.** The signed-in agent accepts with `POST /v1/workspaces/accept` and the invitation token. Acceptance binds the exact verified subject: a reused invitation admits no other identity, an expired invitation admits nobody, and a revoked member cannot rejoin with an old invitation — an owner must restore access explicitly. An agent that is already an active member cannot accept a fresh invitation to reset its role or exclusions; the request fails with `409 conflict`, and the owner edits that member's access policy or revokes it and sends a fresh invitation. A new member starts with an all-functions policy at the invited role. An invitation issued by a delegated administrator stops working if that administrator's own delegated access expires or is revoked.
4. **Select the workspace.** Joining does not auto-select the workspace. To operate there, the agent explicitly selects it (`POST /v1/workspaces/select` or the `workspace_select` MCP tool), or re-runs `ol login --agentid --workspace WORKSPACE_ID`, which mints a new credential for that workspace.
5. **Scope adjustments.** The owner (or an administrator) narrows scope with exclusions or switches the member to selected-functions mode via the access-policy endpoints or the `policy_update` MCP tool.
6. **Revocation.** `POST /v1/workspace/agents/:id/revoke` denies all functions immediately, revokes any agent connection bound to that member, and records the event in the audit log.

The console exposes the same flow: open `https://www.openlaunch.dev/console/?agentid=1` as the AgentID sign-in entrypoint, then manage **Connections → Agents** from the owner or administrator session.

## CLI login

Two ways to authenticate `ol`:

- **`ol login --agentid`** (new): opens the browser at the console sign-in page (`/console/?agentid=1`) for AgentID sign-in. After the upstream identity check, the service issues a one-time opaque login code that is delivered only to the CLI's exact local callback — a clean `127.0.0.1` URL with a random port and `/callback` path; any other callback shape is rejected — and the CLI completes a PKCE exchange for an `ol_agent_` credential. The PKCE verifier and the bearer credential never appear in URLs, logs or the callback response. The code expires in 60 seconds and is single-use. The minted credential carries its own all-functions policy with no local exclusions, the member's role at mint time as its ceiling, and a 24-hour expiry — and it points at the member's live policy, so parent exclusions, selected-mode grants, role changes and revocation apply to it immediately. It is saved with private file permissions (`0600`). `--no-open` prints the sign-in URL instead of launching a browser.
- **Plain token login**: `ol login` still prompts for a pasted agent API credential from Connections, verifies it with read-only discovery, and saves it privately. This path is unchanged and works without AgentID.

Workspace selection differs between the two login kinds:

- An **identity-bound** (AgentID) credential can join and select workspaces. Joining does not auto-select the joined workspace. A select call from a scoped API/OAuth credential returns the target for that connection's requests but does not persist the identity-wide default; only a verified browser session's `POST /v1/workspaces/select` saves the default. The CLI therefore requires `ol login --agentid --workspace WORKSPACE_ID`, which mints a fresh credential for that workspace.
- A **plain API token** remains fixed to the workspace embedded in its token; it cannot join or select workspaces and a workspace-switch request header is rejected.

`ol logout` removes the saved credential; server-side access ends when the connection or membership is revoked.

## API surface

| Method | Route | Who | Purpose |
| --- | --- | --- | --- |
| POST | `/v1/workspace/invitations` | signed-in administrator/owner | Create a one-time invitation for a named agent |
| GET | `/v1/workspace/agents` | administrator/owner | List workspace agent members |
| POST | `/v1/workspace/agents/:id/revoke` | administrator/owner | Revoke a member and its bound connections |
| GET | `/v1/workspaces` | verified identity | List home and joined workspaces |
| POST | `/v1/workspaces/accept` | verified identity | Accept an invitation into the inviting workspace |
| POST | `/v1/workspaces/select` | verified identity | Choose the workspace for subsequent operations |
| GET | `/v1/access` | signed-in principal | Read the caller's effective access policy |
| GET | `/v1/access-policies` | administrator/owner | List member access policies |
| POST | `/v1/access-policies` | administrator/owner | Set a member's mode, exclusions and expiry |
| GET | `/v1/onboarding` | administrator/owner | Read device, connection and access readiness with suggested next steps |
| POST | `/v1/cli-login/authorize` | verified browser session | Start an `ol login --agentid` exchange |
| POST | `/v1/cli-login/exchange` | public (code + PKCE verifier) | Complete the exchange and receive the credential |

Workspace semantics: an identity-bound credential can list and accept workspaces, but only a verified browser session's `POST /v1/workspaces/select` persists the identity-wide default. A scoped API or OAuth credential's select call returns the target for that connection's requests without mutating the identity default, and the CLI requires `ol login --agentid --workspace WORKSPACE_ID` to operate in another workspace. The `/v1/access`, `/v1/access-policies` and `/v1/onboarding` routes are part of this release's management surface and follow the same role checks as the MCP tools below.

## MCP management tools

The hosted MCP endpoint exposes a compact, named management tool set shared with the HTTP routes, so authorization cannot drift between them. Every call re-checks the live hub policy; role never comes from request metadata or cached arguments. Write tools are limited to owners and live delegated administrators:

| Tool | Purpose |
| --- | --- |
| `onboarding_status` | Devices, setup-token and connection readiness plus next steps (manager only) |
| `access_get` | This connection's effective access policy: role, mode, exclusions, expiry |
| `policy_list` | List workspace access policies (manager only) |
| `policy_update` | Create or replace one principal's policy; `selected` keeps legacy grants, `all` covers every device with opt-out exclusions |
| `agent_connection_list` / `agent_connection_create` / `agent_connection_revoke` | Manage agent API connections; secrets appear once |
| `setup_token_create` | Create an attach-only `ol_sdk_` setup token |
| `revoke_device` | Revoke a device credential and cancel queued actions |
| `oauth_client_list` / `oauth_client_create` / `oauth_client_revoke` | Manage OAuth clients; secrets appear once |
| `workspace_list` | List workspaces this identity belongs to, with roles |
| `workspace_select` | Choose the workspace for subsequent operations |
| `workspace_accept` | Accept a one-time workspace invitation |
| `workspace_agents` | List members with role and revoked status (manager only) |
| `workspace_invite` | Invite an agent; `administrator` role requires the owner |
| `workspace_agent_revoke` | Revoke a member and its credentials (manager only) |

Workspace tools call only a fixed whitelist of hosted routes through the identity's trusted context; there is no generic HTTP proxy tool. Delegated administrators may only manage operator policies for other principals, never their own or their ancestors' policies, and only the owner grants the administrator role. There are still no grant or enrollment tools for regular agents: a model cannot escalate its own access.

## Boundaries that do not change

- AgentID is upstream sign-in through Clerk. Raw AgentID tokens never authenticate the device API or MCP; the hosted service verifies Clerk sessions and issued openlaunch credentials only.
- Memberships never merge by email. `owner_email` is never an account-linking or authorization key; only the exact invited Clerk subject can accept.
- Device setup credentials (`ol_sdk_`) remain attach-only. The setup token cannot operate a device; the attached device receives its own private child credential.
- An operator's runtime control still passes every per-call check: connection access ceiling, access policy and exclusions, and device state. Model output cannot authorize itself.
- Linux local shell/desktop control remains a local owner opt-in (`openlaunch-host enable-control`), and hardware interlocks are unchanged; a cloud-side all-functions policy does not enable local hardware features by itself.
- Home Assistant discovery still requires a reachable local gateway and owner-approved linked-device quota; the gateway's local HA credential stays separate.

## Privacy notes

Workspace membership records store the agent's display name (chosen in the invitation), the Clerk-derived identity identifier, role, join time and revocation state, plus a bounded audit trail of invitation, join and revocation events. No new external provider is introduced: membership data lives in the existing workspace storage alongside the other records, and the owner's email is never used to link or admit an agent. See [Privacy Policy](https://www.openlaunch.dev/docs/privacy).

## Tester checklist

With an AgentID-enrolled agent inbox and a workspace:

```sh
# Owner, in the console: Connections → Agents → Invite (name + role)
# Agent: complete AgentID sign-in, then accept the invitation
ol login --agentid
ol devices list
ol functions list
ol call DEVICE_ID device.health
ol actions watch ACTION_ID

# Owner, from the CLI instead of the console:
ol agents list
ol agents invite "Test agent" --role operator
ol agents revoke AGENT_ID
ol access policies
ol workspace list
```

The agent can accept an invitation with `ol workspace join` (hidden prompt for the `ol_inv_` code) after `ol login --agentid`.

Check: the agent sees workspace devices without a per-device grant (all-functions default), an exclusion hides its function, a selected-mode legacy connection still needs explicit grants, re-inviting an already-active member returns `409 conflict`, revoking the member stops the CLI credential at the next call, and an expired or reused invitation fails closed. After the agent accepts an invitation to a second workspace, confirm that joining does not auto-select it, that plain API tokens still resolve only their original workspace, and that explicit selection or `ol login --agentid --workspace WORKSPACE_ID` is needed to operate in the joined one.

The compact `ol` commands for this surface are documented in the [CLI guide](https://www.openlaunch.dev/docs/cli): `ol status`, `ol workspace list|join`, `ol agents list|invite|revoke`, `ol access [policies|set]`, `ol onboarding`, `ol setup token`, `ol connections` and `ol devices revoke`. The hosted MCP tools share the same checks under the names listed above.

Noninteractive device setup (agents, CI, headless hosts) works without a terminal: pass an explicit mode to the setup helper instead of the interactive menu, or set `OPENLAUNCH_SDK_TOKEN` in the environment for the Linux/Pi installers and `OPENLAUNCH_HA_URL` / `OPENLAUNCH_HA_TOKEN` for the Home Assistant gateway. Set these variables privately in the shell or secret store; never put credential values in command arguments, logs or documentation. The Home Assistant gateway's `OPENLAUNCH_SETUP_TOKEN` remains attach-only. Device updates preserve the existing identity, policy and journal.

Without an enrolled agent inbox: complete steps 1–2 of the flow in the console and verify the invitation lifecycle (expiry, single use, role restriction for administrators) against the API; the joined-agent steps need the enrolled inbox, and the next step is to rerun this checklist when it is available. Without physical hardware: `device.health` against the simulated adapter validates authorization only — a receipt is not a physical result.
