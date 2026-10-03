/** Provider-independent protocol. No model names, provider credentials or raw shell commands. */
export const PROTOCOL_VERSION = 1 as const;
export type DeviceKind = "uno-r4-wifi" | "raspberry-pi-4";
export type ActionState =
  | "queued"
  | "received"
  | "running"
  | "succeeded"
  | "failed"
  | "expired"
  | "unknown";
export interface Capability {
  name: string;
  access: "read" | "write";
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}
export interface DeviceManifest {
  protocolVersion: typeof PROTOCOL_VERSION;
  deviceId: string;
  kind: DeviceKind;
  capabilities: Capability[];
}
export interface ActionEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  actionId: string;
  deviceId: string;
  capability: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}
export function isExpired(action: ActionEnvelope, now: number): boolean {
  return now >= action.expiresAt;
}
