import { z } from "zod";
import {
  Hub,
  Fault,
  hash,
  type Principal,
} from "../../../packages/core/src/index.ts";

export interface IdentityStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  list<T>(options: { prefix: string; limit?: number }): Promise<Map<string, T>>;
}
/** Stage metadata until the canonical SQL state commits. A failed SQL write
 * must never consume a login code or invitation. Metadata retries are safe. */
export class DeferredIdentityStore implements IdentityStore {
  private pending = new Map<string, unknown>();
  constructor(private readonly store: IdentityStore) {}
  async get<T>(key: string): Promise<T | undefined> {
    return this.pending.has(key)
      ? (structuredClone(this.pending.get(key)) as T | undefined)
      : this.store.get<T>(key);
  }
  async put<T>(key: string, value: T) {
    this.pending.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.pending.set(key, undefined);
  }
  async list<T>(options: { prefix: string; limit?: number }) {
    const records = await this.store.list<T>(options);
    for (const [key, value] of this.pending)
      if (key.startsWith(options.prefix)) {
        if (value === undefined) records.delete(key);
        else records.set(key, structuredClone(value) as T);
      }
    return new Map(
      [...records]
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, options.limit),
    );
  }
  async commit() {
    for (const [key, value] of this.pending) {
      if (value === undefined) await this.store.delete(key);
      else await this.store.put(key, value);
    }
    this.pending.clear();
  }
}
export type WorkspaceMembership = {
  workspace: string;
  principalId: string;
  name: string;
  role: "operator" | "administrator";
};
export type AgentMember = {
  id: string;
  identityId: string;
  name: string;
  role: "operator" | "administrator";
  joinedAt: number;
  revoked: boolean;
  admissionHash?: string;
};
type Invitation = {
  name: string;
  role: "operator" | "administrator";
  expiresAt: number;
  acceptedBy?: string;
  memberId?: string;
  delegatedFrom?: string;
};
type CliCode = {
  challenge: string;
  identityId: string;
  principalId: string;
  owner: boolean;
  expiresAt: number;
  consumed?: boolean;
};
export type CredentialIdentity = {
  identityId: string;
  principalId: string;
  owner: boolean;
};
const identityPattern = /^[a-f0-9]{64}$/;
const nonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};
const tokenWorkspace = (value: string, kind: "inv" | "login") =>
  new RegExp(`^ol_${kind}_([a-f0-9]{64})_[A-Za-z0-9_-]{43}$`).exec(value)?.[1];
export const invitationWorkspace = (value: string) =>
  tokenWorkspace(value, "inv");
export const loginWorkspace = (value: string) => tokenWorkspace(value, "login");
const invitationSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    role: z.enum(["operator", "administrator"]).default("operator"),
    ttlSeconds: z.number().int().min(60).max(3600).default(600),
  })
  .strict();
const authorizeSchema = z
  .object({
    callbackUrl: z.string().max(200),
    state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
const exchangeSchema = z
  .object({
    code: z.string().max(200),
    verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  })
  .strict();
export function validateCliCallback(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Fault("invalid", 400, "Invalid CLI callback URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/callback" ||
    url.search ||
    url.hash ||
    value !== url.href
  )
    throw new Fault(
      "invalid",
      400,
      "CLI callback must be an exact 127.0.0.1 callback URL with a port",
    );
  return url.href;
}
export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export const dataResponse = (data: unknown, status = 200) =>
  Response.json(
    { data },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
export async function boundedJson(request: Request) {
  // These operations are small and never contain an upstream provider credential.
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) {
          await reader.cancel();
          throw new Fault("too_large", 413, "Request too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new Fault("invalid_json", 400, "Invalid JSON");
  }
}
export function onboardingError(error: unknown): Response {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: {
          code: "validation",
          message: "Invalid request",
          issues: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  if (error instanceof Fault)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: { "cache-control": "no-store" } },
    );
  return Response.json(
    { error: { code: "internal", message: "Unable to complete onboarding" } },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

/** Private index inside the existing DO namespace. Only the authenticated edge calls it. */
export async function identityDirectory(
  store: IdentityStore,
  request: Request,
) {
  const path = new URL(request.url).pathname;
  const records =
    (await store.get<WorkspaceMembership[]>("identity:memberships")) ?? [];
  if (path === "/__identity/list" && request.method === "GET")
    return dataResponse({
      memberships: records,
      selected: await store.get<string>("identity:selected"),
    });
  if (path === "/__identity/link" && request.method === "POST") {
    const member = z
      .object({
        workspace: z.string().regex(identityPattern),
        principalId: z.string().min(1).max(128),
        name: z.string().min(1).max(64),
        role: z.enum(["operator", "administrator"]),
      })
      .strict()
      .parse(await boundedJson(request));
    const next = records.filter((r) => r.workspace !== member.workspace);
    if (next.length >= 100)
      throw new Fault("quota", 429, "Workspace membership limit reached");
    next.push(member);
    await store.put("identity:memberships", next);
    return dataResponse(member);
  }
  if (path === "/__identity/select" && request.method === "POST") {
    const { workspace } = z
      .object({ workspace: z.string().regex(identityPattern) })
      .strict()
      .parse(await boundedJson(request));
    await store.put("identity:selected", workspace);
    return dataResponse({ workspace });
  }
  throw new Fault("not_found", 404, "Identity operation not found");
}

/** Workspace-local invitation and login records; opaque secrets are stored only as hashes. */
export class AgentOnboarding {
  constructor(
    private store: IdentityStore,
    private workspace: string,
    private now: () => number = Date.now,
  ) {}
  async members(hub?: Hub) {
    const members = [
      ...(
        await this.store.list<AgentMember>({
          prefix: "agent:member:",
          limit: 101,
        })
      ).values(),
    ];
    return hub
      ? members.map(({ admissionHash: _admissionHash, ...member }) => ({
          ...member,
          role:
            hub.effectiveAccess({ id: member.id, owner: false }).role ===
            "administrator"
              ? ("administrator" as const)
              : ("operator" as const),
        }))
      : members;
  }
  async member(identityId: string) {
    return this.store.get<AgentMember>("agent:member:" + identityId);
  }
  private manager(hub: Hub, p: Principal) {
    p = hub.applyAccessPolicy(p);
    if ((!p.owner && !p.administrator) || p.readOnly)
      throw new Fault("forbidden", 403, "Workspace administrator required");
    return p;
  }
  private audit(hub: Hub, event: string, target: string, p: Principal) {
    hub.state.audit.push({
      at: this.now(),
      event,
      target,
      principal: p.identityId ?? p.id,
    });
    hub.state.audit = hub.state.audit.slice(-1000);
  }
  async invite(hub: Hub, p: Principal, input: unknown) {
    p = this.manager(hub, p);
    const config = invitationSchema.parse(input);
    // An administrator's restrictions cannot be escaped by inviting another identity.
    if (!p.owner && config.role === "administrator")
      throw new Fault(
        "forbidden",
        403,
        "Only the workspace owner can delegate administration",
      );
    const invitations = await this.store.list<Invitation>({
      prefix: "agent:invitation:",
      limit: 101,
    });
    for (const [key, value] of invitations)
      if (value.expiresAt <= this.now()) await this.store.delete(key);
    if (
      [...invitations.values()].filter((v) => v.expiresAt > this.now())
        .length >= 50
    )
      throw new Fault("quota", 429, "Too many pending invitations");
    const invitation = `ol_inv_${this.workspace}_${nonce()}`;
    const expiresAt = this.now() + config.ttlSeconds * 1000;
    await this.store.put("agent:invitation:" + (await hash(invitation)), {
      name: config.name,
      role: config.role,
      expiresAt,
      ...(!p.owner ? { delegatedFrom: p.id } : {}),
    } satisfies Invitation);
    this.audit(hub, "agent.invited", config.name, p);
    return { invitation, expiresAt };
  }
  async accept(hub: Hub, identityId: string, invitation: string) {
    if (
      !identityPattern.test(identityId) ||
      invitationWorkspace(invitation) !== this.workspace
    )
      throw new Fault("invalid", 400, "Invalid workspace invitation");
    const key = "agent:invitation:" + (await hash(invitation));
    const record = await this.store.get<Invitation>(key);
    if (
      !record ||
      record.expiresAt <= this.now() ||
      (record.acceptedBy && record.acceptedBy !== identityId)
    )
      throw new Fault(
        "unauthorized",
        401,
        "Invitation expired or already used",
      );
    if (
      record.delegatedFrom &&
      !hub.applyAccessPolicy({ id: record.delegatedFrom, owner: false })
        .administrator
    )
      throw new Fault(
        "unauthorized",
        401,
        "Invitation issuer's delegated access expired or was revoked",
      );
    const prior = await this.member(identityId);
    if (
      prior &&
      !prior.revoked &&
      !record.acceptedBy &&
      prior.admissionHash !== key
    )
      throw new Fault(
        "conflict",
        409,
        "Agent is already linked; edit its access policy or revoke it before inviting it again",
      );
    if (prior?.revoked && (record.acceptedBy || record.delegatedFrom))
      throw new Fault(
        "forbidden",
        403,
        "This agent was revoked; an owner must restore access explicitly",
      );
    if (!prior && (await this.members()).length >= 100)
      throw new Fault("quota", 429, "Workspace agent limit reached");
    const member: AgentMember =
      prior && !prior.revoked
        ? prior
        : {
            id: `agent:${identityId}`,
            identityId,
            name: record.name,
            role: record.role,
            joinedAt: this.now(),
            revoked: false,
            admissionHash: key,
          };
    // An invitation is admission authority. No model-supplied identity or email can substitute.
    if (
      !prior ||
      prior.revoked ||
      !hub.state.accessPolicies?.some(
        (policy) => policy.principal === member.id,
      )
    )
      hub.setAccessPolicy(
        { id: "owner", owner: true },
        {
          principal: member.id,
          mode: "all",
          excludedDevices: [],
          excludedFunctions: [],
          role: member.role,
          expiresAt: null,
          ...(record.delegatedFrom
            ? { delegatedFrom: record.delegatedFrom }
            : {}),
        },
      );
    await this.store.put("agent:member:" + identityId, member);
    await this.store.put(key, {
      ...record,
      acceptedBy: identityId,
      memberId: member.id,
    });
    if (!prior || prior.revoked)
      this.audit(hub, "agent.joined", member.id, {
        id: member.id,
        owner: false,
        identityId,
      });
    return {
      workspace: this.workspace,
      principalId: member.id,
      name: member.name,
      role: member.role,
    } satisfies WorkspaceMembership;
  }
  async revoke(hub: Hub, p: Principal, memberId: string) {
    p = this.manager(hub, p);
    if (!p.owner && memberId === p.id)
      throw new Fault("forbidden", 403, "Cannot change your own membership");
    const member = (await this.members()).find((m) => m.id === memberId);
    if (!member) throw new Fault("not_found", 404, "Agent not found");
    if (
      !p.owner &&
      hub.applyAccessPolicy({ id: member.id, owner: false }).administrator
    )
      throw new Fault(
        "forbidden",
        403,
        "Only the owner can revoke an administrator",
      );
    member.revoked = true;
    const parent = hub.state.accessPolicies?.find(
      (policy) => policy.principal === member.id,
    )?.delegatedFrom;
    // A selected empty policy denies all functions and administration immediately.
    hub.setAccessPolicy(p, {
      principal: member.id,
      mode: "selected",
      excludedDevices: [],
      excludedFunctions: [],
      role: "operator",
      expiresAt: this.now(),
      ...(parent ? { delegatedFrom: parent } : {}),
    });
    hub.state.grants = hub.state.grants.filter(
      (g) => g.principal !== member.id,
    );
    await this.store.put("agent:member:" + member.identityId, member);
    for (const connection of hub.state.agentConnections ?? []) {
      const binding = await this.store.get<CredentialIdentity>(
        "agent:credential:" + connection.principal,
      );
      if (binding?.principalId === member.id && !connection.revoked)
        hub.revokeConnection({ id: "owner", owner: true }, connection.id);
    }
    this.audit(hub, "agent.revoked", member.id, p);
    return { ok: true };
  }
  async authorize(hub: Hub, p: Principal, identityId: string, input: unknown) {
    if (!identityPattern.test(identityId))
      throw new Fault("unauthorized", 401, "Verified sign-in required");
    const config = authorizeSchema.parse(input);
    validateCliCallback(config.callbackUrl);
    const records = await this.store.list<CliCode>({
      prefix: "agent:login:",
      limit: 101,
    });
    for (const [key, value] of records)
      if (value.expiresAt <= this.now()) await this.store.delete(key);
    if (
      [...records.values()].filter((v) => v.expiresAt > this.now()).length >= 50
    )
      throw new Fault("quota", 429, "Too many pending sign-ins");
    const code = `ol_login_${this.workspace}_${nonce()}`;
    await this.store.put("agent:login:" + (await hash(code)), {
      challenge: config.challenge,
      identityId,
      principalId: p.id,
      owner: p.owner,
      expiresAt: this.now() + 60_000,
    } satisfies CliCode);
    this.audit(hub, "cli.login_authorized", p.id, p);
    return { code, state: config.state, callbackUrl: config.callbackUrl };
  }
  async exchange(hub: Hub, input: unknown) {
    const { code, verifier } = exchangeSchema.parse(input);
    if (loginWorkspace(code) !== this.workspace)
      throw new Fault("unauthorized", 401, "Invalid login code");
    const key = "agent:login:" + (await hash(code));
    const record = await this.store.get<CliCode>(key);
    if (
      !record ||
      record.consumed ||
      record.expiresAt <= this.now() ||
      record.challenge !== (await pkceChallenge(verifier))
    )
      throw new Fault(
        "unauthorized",
        401,
        "Login expired, already used, or PKCE verifier invalid",
      );
    const parent = record.owner
      ? undefined
      : await this.member(record.identityId);
    if (
      !record.owner &&
      (!parent || parent.revoked || parent.id !== record.principalId)
    )
      throw new Fault(
        "unauthorized",
        401,
        "Workspace membership no longer active",
      );
    const source = hub.applyAccessPolicy({
      id: record.principalId,
      owner: record.owner,
      identityId: record.identityId,
    });
    if (!record.owner && !hub.effectiveAccess(source).role)
      throw new Fault(
        "forbidden",
        403,
        "Workspace access expired; ask the owner to renew it before signing in",
      );
    const role =
      source.owner || source.administrator ? "administrator" : "operator";
    const connection = await hub.createConnection(
      { id: "owner", owner: true },
      this.workspace,
      "ol CLI",
      86400,
      source.readOnly ? "read" : "act",
      { canAttach: false, deviceLimit: 0 },
      "agent",
    );
    hub.setAccessPolicy(
      { id: "owner", owner: true },
      {
        principal: connection.principal,
        // The parent is the live authority, rather than a stale snapshot of
        // its exclusions. A selected parent also gates its own grants.
        mode: "all",
        excludedDevices: [],
        excludedFunctions: [],
        role,
        expiresAt: connection.expiresAt,
        ...(!record.owner ? { delegatedFrom: record.principalId } : {}),
      },
    );
    await this.store.put("agent:credential:" + connection.principal, {
      identityId: record.identityId,
      principalId: record.principalId,
      owner: record.owner,
    } satisfies CredentialIdentity);
    await this.store.put(key, { ...record, consumed: true });
    this.audit(hub, "cli.login_completed", connection.id, source);
    return {
      token: connection.token,
      workspace: this.workspace,
      connectionId: connection.id,
      expiresAt: connection.expiresAt,
      access: connection.access,
      role,
    };
  }
  async credentialIdentity(principalId: string) {
    return this.store.get<CredentialIdentity>(
      "agent:credential:" + principalId,
    );
  }
}
