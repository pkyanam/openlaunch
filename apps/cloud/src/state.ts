import { Hub, emptyState, type State } from "../../../packages/core/src/index.ts";

export interface WorkspaceStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

// Call inside the Durable Object's concurrency boundary. Capture the persisted
// snapshot before handing its mutable object to Hub.
export async function withWorkspaceState<T>(
  storage: WorkspaceStorage,
  operation: (hub: Hub) => Promise<T>,
): Promise<T> {
  const state = (await storage.get<State>("state")) ?? emptyState();
  const before = JSON.stringify(state);
  const hub = new Hub(state);
  const result = await operation(hub);
  if (JSON.stringify(hub.state) !== before)
    await storage.put("state", hub.state);
  return result;
}
