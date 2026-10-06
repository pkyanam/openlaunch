import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type AccessPolicy,
  type AccountSummary,
  type OnboardingStep,
  type WorkspaceMember,
  type WorkspaceMembership,
} from "./workspace";

type DeviceLite = {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  gatewayId?: string;
};
type ConnectionLite = {
  id: string;
  principal: string;
  name: string;
  access: "read" | "act";
  expiresAt: number | null;
  purpose?: string;
  revoked?: boolean;
};
type OAuthLite = {
  id: string;
  principal: string;
  name: string;
  revoked?: boolean;
};

type Props = {
  api: (path: string, method?: string, data?: unknown) => Promise<any>;
  run: (fn: () => Promise<void>) => void;
  busy: boolean;
  notify: (message: string) => void;
  confirm: (message: string) => Promise<boolean>;
  account: AccountSummary;
  devices: DeviceLite[];
  connections: ConnectionLite[];
  oauthConnections: OAuthLite[];
  initialPrincipal?: string;
  onSelectWorkspace: (workspace: string) => Promise<void> | void;
  /** Called after join/revoke when account or inventory state may have changed. */
  onWorkspaceDataChanged: () => void;
};

type PrincipalOption = {
  value: string;
  label: string;
  kind: "member" | "api" | "oauth";
  role?: string;
};

const roleChips: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  operator: "Operator",
};

const formatDateTime = (value?: number | null) =>
  typeof value === "number" && !Number.isNaN(value)
    ? new Date(value).toLocaleString()
    : "—";

function asArray<T>(value: unknown, key?: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && key) {
    const inner = (value as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function asPolicy(value: unknown): AccessPolicy | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate =
    record.policy && typeof record.policy === "object" ? record.policy : record;
  if (typeof (candidate as AccessPolicy).principal !== "string") return null;
  const policy = candidate as AccessPolicy;
  return {
    principal: policy.principal,
    mode:
      policy.mode === "all" || record.source === "owner" ? "all" : "selected",
    excludedDevices: Array.isArray(policy.excludedDevices)
      ? policy.excludedDevices
      : [],
    excludedFunctions: Array.isArray(policy.excludedFunctions)
      ? policy.excludedFunctions
      : [],
    role: policy.role === "administrator" ? "administrator" : "operator",
    expiresAt: typeof policy.expiresAt === "number" ? policy.expiresAt : null,
    ...(policy.delegatedFrom ? { delegatedFrom: policy.delegatedFrom } : {}),
  };
}

function policySummary(policy: AccessPolicy | null, devices: DeviceLite[]) {
  if (!policy) return null;
  if (policy.mode === "selected") return "Selected functions via saved grants";
  const deviceNames = policy.excludedDevices.map(
    (id) => devices.find((device) => device.id === id)?.name ?? id,
  );
  const functionCount = policy.excludedFunctions.length;
  const parts: string[] = [];
  if (deviceNames.length) parts.push(`excluding ${deviceNames.join(", ")}`);
  if (functionCount)
    parts.push(
      `excluding ${functionCount} function${functionCount === 1 ? "" : "s"}`,
    );
  return parts.length
    ? `All functions, ${parts.join(" and ")}`
    : "All functions";
}

export function AgentsArea({
  api,
  run,
  busy,
  notify,
  confirm,
  account,
  devices,
  connections,
  oauthConnections,
  initialPrincipal,
  onSelectWorkspace,
  onWorkspaceDataChanged,
}: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[] | null>(
    null,
  );
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [policies, setPolicies] = useState<AccessPolicy[] | null>(null);
  const [yourAccess, setYourAccess] = useState<AccessPolicy | null>(null);
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const isOwner = account.principal.owner === true;
  const isAdministrator = account.principal.administrator === true;
  const isManager = isOwner || isAdministrator;
  const selfIdentity = account.principal.identityId ?? account.principal.id;

  const load = useCallback(() => {
    return run(async () => {
      const [
        workspacesResult,
        membersResult,
        policiesResult,
        accessResult,
        stepsResult,
      ] = await Promise.allSettled([
        api("/v1/workspaces"),
        api("/v1/workspace/agents"),
        api("/v1/access-policies"),
        api("/v1/access"),
        api("/v1/onboarding"),
      ]);
      if (workspacesResult.status === "fulfilled") {
        setWorkspaces(asArray<WorkspaceMembership>(workspacesResult.value));
        setLoadError("");
      } else {
        setLoadError(
          workspacesResult.reason instanceof Error
            ? workspacesResult.reason.message
            : "Workspaces could not be loaded.",
        );
      }
      setMembers(
        membersResult.status === "fulfilled"
          ? asArray<WorkspaceMember>(membersResult.value, "members")
          : [],
      );
      const loadedPolicies = asArray<AccessPolicy>(
        policiesResult.status === "fulfilled" ? policiesResult.value : null,
        "policies",
      )
        .map((policy) => asPolicy(policy))
        .filter(Boolean) as AccessPolicy[];
      setPolicies(loadedPolicies);
      setYourAccess(
        accessResult.status === "fulfilled"
          ? asPolicy(accessResult.value)
          : null,
      );
      const rawSteps =
        stepsResult.status === "fulfilled" ? stepsResult.value : null;
      const loadedSteps = asArray<string>(rawSteps, "nextSteps")
        .filter((step) => typeof step === "string")
        .map((title) => ({ title }));
      setSteps(loadedSteps.length ? loadedSteps : null);
    });
  }, [api, run]);

  useEffect(() => {
    void load();
    // Loads when the Agents tab is opened; refreshes after explicit actions.
  }, []);

  // --- Workspaces: switch and join ---------------------------------------

  const [joinCode, setJoinCode] = useState("");
  const [joined, setJoined] = useState<string | null>(null);

  const joinWorkspace = () =>
    run(async () => {
      const code = joinCode.trim();
      if (!code) throw new Error("Enter an invitation code first.");
      const result = await api("/v1/workspaces/accept", "POST", {
        invitation: code,
      });
      // Accepting does not switch the identity's workspace automatically, so
      // explicitly select the returned workspace, then load it.
      await api("/v1/workspaces/select", "POST", {
        workspace: result.workspace,
      });
      setJoined(String(result.workspace));
      setJoinCode("");
      await onSelectWorkspace(result.workspace);
    });

  // --- Members ------------------------------------------------------------

  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<"operator" | "administrator">(
    "operator",
  );
  const [inviteTtl, setInviteTtl] = useState(600);
  const [invite, setInvite] = useState<{
    code: string;
    expiresAt: number;
    name: string;
    role: string;
  } | null>(null);

  const sendInvite = () =>
    run(async () => {
      if (!isManager)
        throw new Error(
          "Only the workspace owner or an administrator can invite members.",
        );
      if (!inviteName.trim()) throw new Error("Enter the member's name first.");
      const result = await api("/v1/workspace/invitations", "POST", {
        name: inviteName.trim(),
        role: inviteRole,
        ttlSeconds: inviteTtl,
      });
      setInvite({
        code: String(result?.invitation ?? ""),
        expiresAt:
          typeof result?.expiresAt === "number"
            ? result.expiresAt
            : Date.now() + inviteTtl * 1000,
        name: inviteName.trim(),
        role: inviteRole,
      });
      setInviteName("");
      notify(
        `Invitation for ${inviteName.trim()} created. It expires at ${new Date(Date.now() + inviteTtl * 1000).toLocaleTimeString()}.`,
      );
    });

  const revokeMember = (member: WorkspaceMember) =>
    run(async () => {
      if (
        !(await confirm(
          `Revoke ${member.name}'s access to this workspace? Their credentials and CLI logins for it stop working.`,
        ))
      )
        return;
      await api(`/v1/workspace/agents/${member.id}/revoke`, "POST", {});
      notify(`${member.name}'s access was revoked.`);
      await load();
      onWorkspaceDataChanged();
    });

  // --- Access policies ----------------------------------------------------

  const principalOptions = useMemo<PrincipalOption[]>(() => {
    const options = new Map<string, PrincipalOption>();
    const revoked = new Set([
      ...(members ?? [])
        .filter((member) => member.revoked)
        .map((member) => member.id),
      ...connections
        .filter((connection) => connection.revoked)
        .map((connection) => connection.principal),
      ...oauthConnections
        .filter((connection) => connection.revoked)
        .map((connection) => connection.principal),
    ]);
    for (const member of (members ?? []).filter((m) => !m.revoked)) {
      const value = member.id;
      if (!options.has(value))
        options.set(value, {
          value,
          label: `${member.name} · member`,
          kind: "member",
          role: member.role,
        });
    }
    for (const connection of connections.filter(
      (c) => !c.revoked && (c.purpose === "agent" || !c.purpose),
    )) {
      if (!options.has(connection.principal))
        options.set(connection.principal, {
          value: connection.principal,
          label: `${connection.name} · API token`,
          kind: "api",
        });
    }
    for (const client of oauthConnections.filter((client) => !client.revoked)) {
      if (!options.has(client.principal))
        options.set(client.principal, {
          value: client.principal,
          label: `${client.name} · OAuth client`,
          kind: "oauth",
        });
    }
    for (const policy of policies ?? []) {
      if (!revoked.has(policy.principal) && !options.has(policy.principal))
        options.set(policy.principal, {
          value: policy.principal,
          label: `Agent ${policy.principal.slice(0, 24)}…${policy.expiresAt !== null && policy.expiresAt <= Date.now() ? " · expired" : ""}`,
          kind: "oauth",
        });
    }
    return [...options.values()];
  }, [members, connections, oauthConnections, policies]);

  const [selectedPrincipal, setSelectedPrincipal] = useState("");
  const [draft, setDraft] = useState<AccessPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<AccessPolicy | null>(null);
  const [expiryChoice, setExpiryChoice] = useState<number | "keep">("keep");

  const selectPrincipal = (value: string) => {
    setSelectedPrincipal(value);
    const existing =
      (policies ?? []).find((policy) => policy.principal === value) ?? null;
    setSavedPolicy(existing);
    setDraft(
      existing
        ? {
            ...existing,
            excludedDevices: [...existing.excludedDevices],
            excludedFunctions: existing.excludedFunctions.map((entry) => ({
              ...entry,
            })),
          }
        : {
            principal: value,
            mode: "all",
            excludedDevices: [],
            excludedFunctions: [],
            role:
              (members ?? []).find((member) => member.id === value)?.role ===
              "administrator"
                ? "administrator"
                : "operator",
            expiresAt: null,
          },
    );
    setExpiryChoice("keep");
  };

  useEffect(() => {
    if (
      initialPrincipal &&
      policies !== null &&
      !selectedPrincipal &&
      principalOptions.some((option) => option.value === initialPrincipal)
    )
      selectPrincipal(initialPrincipal);
  }, [initialPrincipal, policies, selectedPrincipal, principalOptions]);

  const allCapabilities = useMemo(() => {
    const names = new Set<string>();
    for (const device of devices)
      for (const capability of device.capabilities) names.add(capability);
    return [...names].sort();
  }, [devices]);

  const toggleDeviceExclusion = (deviceId: string, excluded: boolean) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            excludedDevices: excluded
              ? [...current.excludedDevices, deviceId]
              : current.excludedDevices.filter((id) => id !== deviceId),
          }
        : current,
    );

  const updateExclusion = (
    index: number,
    patch: Partial<{ deviceId: string | null; capability: string }>,
  ) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            excludedFunctions: current.excludedFunctions.map((entry, i) =>
              i === index ? { ...entry, ...patch } : entry,
            ),
          }
        : current,
    );

  const removeExclusion = (index: number) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            excludedFunctions: current.excludedFunctions.filter(
              (_, i) => i !== index,
            ),
          }
        : current,
    );

  const addExclusion = () =>
    setDraft((current) =>
      current
        ? {
            ...current,
            excludedFunctions: [
              ...current.excludedFunctions,
              { deviceId: null, capability: "" },
            ],
          }
        : current,
    );

  const savePolicy = () =>
    run(async () => {
      if (!draft || !selectedPrincipal) return;
      const expiresAt =
        expiryChoice === "keep"
          ? (savedPolicy?.expiresAt ?? null)
          : expiryChoice === 0
            ? null
            : Date.now() + expiryChoice * 1000;
      const body: AccessPolicy = { ...draft, expiresAt };
      await api("/v1/access-policies", "POST", body);
      setSavedPolicy(body);
      setDraft(body);
      notify("Access policy saved.");
      await load();
    });

  const policyUnchanged =
    !!draft &&
    !!savedPolicy &&
    savedPolicy.mode === draft.mode &&
    savedPolicy.role === draft.role &&
    savedPolicy.excludedDevices.join("|") === draft.excludedDevices.join("|") &&
    JSON.stringify(savedPolicy.excludedFunctions) ===
      JSON.stringify(draft.excludedFunctions) &&
    expiryChoice === "keep";

  const canEditPolicy =
    isManager &&
    !!draft &&
    (isOwner || savedPolicy?.role !== "administrator") &&
    selectedPrincipal !== selfIdentity &&
    selectedPrincipal !== account.principal.id;

  // --- Render -------------------------------------------------------------

  const knownDevices = devices.filter((device) => !device.gatewayId);

  return (
    <div className="connection-method agents-area">
      <p>
        Workspaces let you share this console's devices with agents and people
        under your control. Members sign in with their own AgentID and receive
        credentials only for workspaces they joined.
      </p>
      {loadError && (
        <p role="alert" aria-live="assertive">
          Workspace data could not be loaded: {loadError}
        </p>
      )}

      {steps && (
        <section
          className="panel step-panel"
          aria-labelledby="agents-steps-title"
        >
          <h3 id="agents-steps-title">Getting started</h3>
          <ol className="step-list">
            {steps.map((step, index) => (
              <li
                key={step.id ?? index}
                data-done={step.done ? "true" : "false"}
              >
                <div>
                  <strong>{step.title}</strong>
                  {step.description && <p>{step.description}</p>}
                </div>
                {step.href && <a href={step.href}>{step.action ?? "Open"}</a>}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel" aria-labelledby="workspaces-title">
        <h3 id="workspaces-title">Your workspaces</h3>
        <p className="muted">
          You are{" "}
          {isOwner
            ? "the owner"
            : isAdministrator
              ? "an administrator"
              : "an operator"}{" "}
          of <code>{account.workspace}</code>. Switching the default workspace
          applies to this session and to console-connected agents.
        </p>
        {yourAccess && (
          <p>
            Your access here:{" "}
            {policySummary(yourAccess, devices) ??
              "managed by the workspace owner"}
            .
          </p>
        )}
        {workspaces && workspaces.length > 0 ? (
          <ul className="connection-list workspace-list">
            {workspaces.map((membership) => {
              const current = membership.workspace === account.workspace;
              return (
                <li key={membership.workspace}>
                  <div>
                    <strong>{membership.name || membership.workspace}</strong>
                    <span>
                      <code>{membership.workspace}</code>
                    </span>
                  </div>
                  <div className="workspace-actions">
                    <span className={`role-chip role-${membership.role}`}>
                      {roleChips[membership.role] ?? membership.role}
                    </span>
                    {current ? (
                      <span className="muted">Current</span>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api("/v1/workspaces/select", "POST", {
                              workspace: membership.workspace,
                            });
                            await onSelectWorkspace(membership.workspace);
                          })
                        }
                      >
                        Switch to this workspace
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : workspaces ? (
          <p role="status" aria-live="polite">
            No other workspaces yet. Join one with an invitation code below.
          </p>
        ) : (
          !loadError && (
            <p role="status" aria-live="polite">
              Loading workspaces…
            </p>
          )
        )}
        <form
          className="agents-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            joinWorkspace();
          }}
        >
          <label>
            Join with an invitation code
            <input
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="Paste the invitation code"
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={busy || !joinCode.trim()}>
            Join workspace
          </button>
        </form>
        {joined && (
          <section className="panel next-step" role="status" aria-live="polite">
            <h4>Joined {joined}</h4>
            <p>
              It is now selected as your workspace. The ol CLI stores one
              credential per workspace: run <code>ol login --agentid</code>{" "}
              again and choose this workspace to save its credential.
            </p>
          </section>
        )}
      </section>

      <section className="panel" aria-labelledby="members-title">
        <h3 id="members-title">Members</h3>
        {members && members.length ? (
          <ul className="connection-list">
            {members.map((member) => {
              const self =
                !!member.identityId && member.identityId === selfIdentity;
              return (
                <li key={member.id}>
                  <div>
                    <strong>
                      {member.name}
                      {self ? " (you)" : ""}
                    </strong>
                    <span>
                      {roleChips[member.role] ?? member.role}
                      {member.revoked ? " · access revoked" : " · active"}
                      {member.joinedAt
                        ? ` · joined ${new Date(member.joinedAt).toLocaleDateString()}`
                        : ""}
                    </span>
                  </div>
                  {!member.revoked &&
                    !self &&
                    isManager &&
                    (isOwner || member.role !== "administrator") && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => revokeMember(member)}
                      >
                        Revoke access
                      </button>
                    )}
                </li>
              );
            })}
          </ul>
        ) : members ? (
          <p role="status" aria-live="polite">
            No named members yet. Invite someone below.
          </p>
        ) : (
          <p role="status" aria-live="polite">
            {isManager
              ? "Loading members…"
              : "The member list is available to the workspace owner."}
          </p>
        )}
        {isManager ? (
          <form
            className="agents-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              sendInvite();
            }}
          >
            <label>
              Member name
              <input
                value={inviteName}
                maxLength={64}
                onChange={(event) => setInviteName(event.target.value)}
                placeholder="e.g. Roomba agent"
              />
            </label>
            <label>
              Role
              <select
                value={inviteRole}
                onChange={(event) =>
                  setInviteRole(
                    event.target.value as "operator" | "administrator",
                  )
                }
              >
                <option value="operator">Operator</option>
                <option value="administrator" disabled={!isOwner}>
                  Administrator
                </option>
              </select>
            </label>
            <label>
              Invitation expires
              <select
                value={inviteTtl}
                onChange={(event) => setInviteTtl(Number(event.target.value))}
              >
                <option value={600}>In 10 minutes</option>
                <option value={3600}>In 1 hour</option>
                <option value={86400}>In 24 hours</option>
              </select>
            </label>
            <button type="submit" disabled={busy || !inviteName.trim()}>
              Create invitation
            </button>
            {!isOwner && (
              <p className="muted">
                Administrators can only be invited by the workspace owner.
              </p>
            )}
            <p className="muted">
              A member that is already active can't be invited again — the
              server rejects the duplicate. Edit their access policy or revoke
              them first; their existing exclusions are preserved.
            </p>
          </form>
        ) : (
          <p className="muted">
            Inviting members and revoking access are handled by the workspace
            owner. Ask them to create an invitation for you to share.
          </p>
        )}
        {invite && (
          <section className="panel next-step" aria-live="polite">
            <h4>Invitation for {invite.name}</h4>
            <label>
              Invitation code · expires {formatDateTime(invite.expiresAt)}
              <textarea readOnly value={invite.code} rows={3} />
            </label>
            <p>
              The new member joins by pasting this code into their console's
              Agents panel. Codes work once and cannot be extended.
            </p>
            <div className="row">
              <button
                type="button"
                className="secondary"
                disabled={busy || !invite.code}
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(invite.code);
                    notify("Invitation code copied.");
                  })
                }
              >
                Copy code
              </button>
              <button type="button" onClick={() => setInvite(null)}>
                Done
              </button>
            </div>
          </section>
        )}
      </section>

      <section className="panel" aria-labelledby="agent-access-title">
        <h3 id="agent-access-title">Agent access</h3>
        <p className="muted">
          New agents and members start with access to all workspace functions.
          Exclude specific devices or functions to narrow what they can use.
          Exclusions are saved server-side and persist until changed here.
        </p>
        {!isManager && (
          <p className="muted">
            Only the workspace owner or an administrator can change agent
            access. Your own access is shown above.
          </p>
        )}
        {isManager && (
          <label>
            Agent or member
            <select
              value={selectedPrincipal}
              onChange={(event) => selectPrincipal(event.target.value)}
            >
              <option value="">Choose an agent or member</option>
              {principalOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft && selectedPrincipal ? (
          <div className="policy-editor">
            <p>
              Current saved access:{" "}
              <strong>
                {policySummary(savedPolicy, devices) ?? "Not saved yet"}
              </strong>
              {savedPolicy?.expiresAt
                ? ` · expires ${new Date(savedPolicy.expiresAt).toLocaleString()}`
                : ""}
            </p>
            {(selectedPrincipal === selfIdentity ||
              selectedPrincipal === account.principal.id) &&
              !isOwner && (
                <p className="muted">
                  You cannot edit your own access policy. Ask another owner or
                  administrator to change it.
                </p>
              )}
            {!isOwner && savedPolicy?.role === "administrator" && (
              <p className="muted">
                Only the workspace owner can change administrator access.
              </p>
            )}
            <label>
              Access mode
              <select
                value={draft.mode}
                disabled={!isManager}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          mode: event.target.value as "all" | "selected",
                        }
                      : current,
                  )
                }
              >
                <option value="all">
                  All workspace functions (with exclusions below)
                </option>
                <option value="selected">
                  Selected functions only (legacy saved grants)
                </option>
              </select>
            </label>
            <label>
              Role
              <select
                value={draft.role}
                disabled={!isOwner}
                onChange={(event) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          role: event.target.value as
                            "operator" | "administrator",
                        }
                      : current,
                  )
                }
              >
                <option value="operator">Operator</option>
                <option value="administrator" disabled={!isOwner}>
                  Administrator
                </option>
              </select>
            </label>
            {!isOwner && (
              <p className="muted">
                Only the workspace owner can grant the administrator role.
              </p>
            )}
            {draft.mode === "all" && (
              <>
                <fieldset>
                  <legend>Excluded devices</legend>
                  <p className="muted">
                    Excluded devices stay connected but this agent cannot use
                    any of their functions.
                  </p>
                  {knownDevices.length ? (
                    knownDevices.map((device) => (
                      <label className="permission" key={device.id}>
                        <input
                          type="checkbox"
                          disabled={!isManager}
                          checked={draft.excludedDevices.includes(device.id)}
                          onChange={(event) =>
                            toggleDeviceExclusion(
                              device.id,
                              event.target.checked,
                            )
                          }
                        />
                        {device.name}
                        <span className="muted">
                          {" "}
                          ({device.capabilities.length} functions)
                        </span>
                      </label>
                    ))
                  ) : (
                    <p className="muted">No devices in this workspace yet.</p>
                  )}
                  {draft.excludedDevices
                    .filter((id) => !devices.some((device) => device.id === id))
                    .map((id) => (
                      <label className="permission" key={id}>
                        <input
                          type="checkbox"
                          disabled={!isManager}
                          checked
                          onChange={(event) =>
                            toggleDeviceExclusion(id, !event.target.checked)
                          }
                        />
                        {id}{" "}
                        <span className="muted">(not in this workspace)</span>
                      </label>
                    ))}
                </fieldset>
                <fieldset>
                  <legend>Excluded functions</legend>
                  <p className="muted">
                    Exclusions apply even when the device is not excluded
                    entirely. Use “Any device” for a capability everywhere.
                  </p>
                  {draft.excludedFunctions.map((entry, index) => (
                    <div className="exclusion-row" key={index}>
                      <label>
                        Device
                        <select
                          disabled={!isManager}
                          value={entry.deviceId ?? ""}
                          onChange={(event) =>
                            updateExclusion(index, {
                              deviceId: event.target.value || null,
                            })
                          }
                        >
                          <option value="">Any device</option>
                          {knownDevices.map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Function
                        <input
                          disabled={!isManager}
                          value={entry.capability}
                          list="agent-exclusion-capabilities"
                          placeholder="e.g. led.set"
                          onChange={(event) =>
                            updateExclusion(index, {
                              capability: event.target.value,
                            })
                          }
                        />
                      </label>
                      {isManager && (
                        <button
                          type="button"
                          className="secondary"
                          disabled={busy}
                          onClick={() => removeExclusion(index)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  <datalist id="agent-exclusion-capabilities">
                    {allCapabilities.map((capability) => (
                      <option key={capability} value={capability} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="secondary"
                    disabled={!isManager || busy}
                    onClick={addExclusion}
                  >
                    Add function exclusion
                  </button>
                </fieldset>
              </>
            )}
            {draft.mode === "selected" && (
              <p className="muted">
                In this mode the agent only reaches functions covered by saved
                grants on each device's Access tab. Existing restrictions are
                preserved.
              </p>
            )}
            <label>
              Access expires
              <select
                value={String(expiryChoice)}
                disabled={!isManager}
                onChange={(event) =>
                  setExpiryChoice(
                    event.target.value === "keep"
                      ? "keep"
                      : Number(event.target.value),
                  )
                }
              >
                <option value="keep">
                  {savedPolicy?.expiresAt
                    ? `Keep current expiry (${new Date(savedPolicy.expiresAt).toLocaleString()})`
                    : "No expiry"}
                </option>
                <option value={0}>Until revoked</option>
                <option value={900}>In 15 minutes</option>
                <option value={3600}>In 1 hour</option>
                <option value={86400}>In 24 hours</option>
                <option value={604800}>In 7 days</option>
              </select>
            </label>
            <div className="row">
              <button
                type="button"
                disabled={busy || !canEditPolicy || policyUnchanged}
                onClick={savePolicy}
              >
                Save access policy
              </button>
              {savedPolicy && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || !canEditPolicy}
                  onClick={() => selectPrincipal(selectedPrincipal)}
                >
                  Reset changes
                </button>
              )}
            </div>
          </div>
        ) : isManager ? (
          <p role="status" aria-live="polite">
            Choose an agent or member to review and narrow its access.
          </p>
        ) : null}
      </section>
    </div>
  );
}
