/** Provider-independent protocol. No model names, provider credentials or raw shell commands. */
export const PROTOCOL_VERSION = 1 as const;
/** Bounded lowercase family identifier; maintained adapters include Uno R4 and Pi 4. */
export type DeviceKind = string;
export type ActionState =
  | "queued"
  | "received"
  | "succeeded"
  | "failed"
  | "expired"
  | "cancelled"
  | "unknown";
export interface Capability {
  name: string;
  title: string;
  description: string;
  access: "read" | "write";
  inputSchema: Record<string, unknown>;
}
export interface DeviceManifest {
  name: string;
  kind: DeviceKind;
  capabilities: string[];
  functions?: Capability[];
}
export interface ActionEnvelope {
  id: string;
  deviceId: string;
  capability: string;
  args: Record<string, unknown>;
  status: ActionState;
  createdAt: number;
  expiresAt: number;
}
export function isExpired(action: ActionEnvelope, now: number): boolean {
  return now >= action.expiresAt;
}
