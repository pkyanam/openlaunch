// Shared types and helpers for hosted workspace features: AgentID entry,
// the ol CLI connection consent, and the Agents area.

export type AccountSummary = {
  workspace: string;
  principal: {
    id: string;
    owner: boolean;
    administrator?: boolean;
    identityId?: string;
    actorType?: string;
  };
  deviceControlsEnabled: boolean;
  agentClients?: string[];
  oauthClientRegistration?: boolean;
};

export type WorkspaceMembership = {
  workspace: string;
  principalId: string;
  name: string;
  role: string;
};

export type WorkspaceMember = {
  id: string;
  identityId?: string;
  name: string;
  role: string;
  revoked: boolean;
  joinedAt?: number;
};

export type AccessPolicy = {
  principal: string;
  mode: "all" | "selected";
  excludedDevices: string[];
  excludedFunctions: { deviceId: string | null; capability: string }[];
  role: "operator" | "administrator";
  expiresAt: number | null;
  delegatedFrom?: string;
};

export type OnboardingStep = {
  id?: string;
  title: string;
  description?: string;
  done?: boolean;
  href?: string;
  action?: string;
};

/** Query parameters that must survive the AgentID sign-in redirect round trip. */
export const agentIdParamKeys = [
  "agentid",
  "cli_callback",
  "cli_state",
  "cli_challenge",
  "workspace",
] as const;

export type AgentIdParams = Partial<
  Record<(typeof agentIdParamKeys)[number], string>
>;

export type CliConnectionRequest = {
  callbackUrl: string;
  state: string;
  challenge: string;
  workspace?: string;
};

export function readAgentIdParams(
  search: URLSearchParams = new URLSearchParams(window.location.search),
): AgentIdParams {
  const picked: AgentIdParams = {};
  for (const key of agentIdParamKeys) {
    const value = search.get(key);
    if (value) picked[key] = value;
  }
  return picked;
}

/**
 * Builds a console path that carries the AgentID/CLI parameters from the
 * current URL into a new path, so they survive Clerk's redirect round trip.
 */
export function agentIdCarryPath(
  base: string,
  search: string = window.location.search,
): string {
  const carried = readAgentIdParams(new URLSearchParams(search));
  const url = new URL(base, window.location.origin);
  const params = url.searchParams;
  for (const key of agentIdParamKeys) {
    const value = carried[key];
    if (value) params.set(key, value);
  }
  return url.pathname + (params.size ? `?${params}` : "") + url.hash;
}

export function isAgentIdEntry(
  search: URLSearchParams = new URLSearchParams(window.location.search),
): boolean {
  return search.get("agentid") === "1";
}

export function readCliRequest(
  search: URLSearchParams = new URLSearchParams(window.location.search),
): CliConnectionRequest | null {
  if (!isAgentIdEntry(search)) return null;
  const callbackUrl = search.get("cli_callback");
  const state = search.get("cli_state");
  const challenge = search.get("cli_challenge");
  if (!callbackUrl && !state && !challenge) return null;
  return {
    callbackUrl: callbackUrl ?? "",
    state: state ?? "",
    challenge: challenge ?? "",
    ...(search.has("workspace") ? { workspace: search.get("workspace")! } : {}),
  };
}

/** Client-side validation of the CLI connection request; the server revalidates. */
export function cliRequestProblem(
  request: CliConnectionRequest,
): string | null {
  let callback: URL;
  try {
    callback = new URL(request.callbackUrl);
  } catch {
    return "The CLI callback URL is not a valid URL.";
  }
  if (callback.protocol !== "http:")
    return "The CLI callback must use plain http on the loopback address.";
  if (callback.hostname !== "127.0.0.1")
    return `The CLI callback must point at 127.0.0.1, not ${callback.hostname}.`;
  if (!callback.port) return "The CLI callback must include a port.";
  if (
    callback.username ||
    callback.password ||
    callback.pathname !== "/callback" ||
    callback.search ||
    callback.hash ||
    callback.href !== request.callbackUrl
  )
    return "The CLI callback must be an exact loopback callback URL.";
  if (
    request.workspace !== undefined &&
    !/^[a-f0-9]{64}$/.test(request.workspace)
  )
    return "Invalid workspace ID.";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(request.state))
    return "The CLI state parameter is missing or invalid.";
  if (!/^[A-Za-z0-9_-]{43}$/.test(request.challenge))
    return "The CLI challenge must be a 43-character S256 code challenge.";
  return null;
}

/**
 * Where the browser should land after the Clerk sign-in callback completes.
 * Keeps the AgentID/CLI parameters that were carried through the callback URL.
 */
export function agentIdDestination(
  search: string = window.location.search,
): string {
  if (!isAgentIdEntry(new URLSearchParams(search))) return "/console/";
  return agentIdCarryPath("/console/", search);
}

export const roleLabels: Record<string, string> = {
  owner: "Owner",
  administrator: "Administrator",
  operator: "Operator",
};
