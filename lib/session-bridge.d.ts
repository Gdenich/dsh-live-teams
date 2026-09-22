import { LiveTeamsError } from "./errors.js";
//#region src/session-bridge.d.ts
export interface SessionDescriptor {
  sessionId: string;
  workspaceId: string | undefined;
  cwd: string | undefined;
  title: string | undefined;
  status: 'idle' | 'running' | 'unknown';
  live: boolean;
  subagentOwned: boolean;
  seq: number;
  agentPreset: string | undefined;
  /**
   * DSH's Session-list projection keeps a Session blank until its first
   * `turn/start`, and the session list hides blank Sessions: the Workspace
   * browser adopts one as its provisional "New session" row and never lists it
   * (`sessionVisible` / `connectWorkspace` in @deepseek-ai/dsh-client-ui-workspace).
   *
   * Only `list` reports this flag, so `undefined` means "not reported", never
   * "known to be visible".
   */
  blank?: boolean;
}
export interface SessionController {
  create(payload: Record<string, unknown>): Promise<unknown>;
  inspect(sessionId: string): Promise<unknown>;
  list?(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  rename(payload: {
    sessionId: string;
    title: string;
  }): Promise<unknown>;
  prompt(payload: {
    requestId: string;
    sessionId: string;
    mode: 'queue' | 'steer';
    content: readonly unknown[];
  }, signal: AbortSignal): Promise<unknown>;
  cancel(payload: {
    sessionId: string;
  }): void;
}
export interface SessionBridge {
  create(request: {
    sessionId?: string;
    workspaceId?: string;
    cwd?: string;
    agentPreset?: string;
  }): Promise<SessionDescriptor>;
  inspect(sessionId: string): Promise<SessionDescriptor | undefined>;
  validateAttachment(sessionId: string, workspaceId: string): Promise<SessionDescriptor>;
  rename(sessionId: string, title: string): Promise<{
    title: string;
    seq: number | undefined;
  }>;
  selectModel(sessionId: string, selection: unknown): never;
  deliver(sessionId: string, envelope: {
    requestId: string;
    mode: 'queue' | 'steer';
    content: readonly unknown[];
  }): Promise<{
    accepted: true;
  }>;
  interrupt(sessionId: string, reason: string): Promise<{
    accepted: true;
  }>;
  reconcile(sessionIds: readonly string[]): Promise<SessionDescriptor[]>;
}
export declare function toBridgeError(error: unknown): LiveTeamsError;
export interface SessionBridgeDeps {
  controller: SessionController | null | undefined;
  agents?: {
    get?: (sessionId: string) => unknown;
  };
}
export declare function createSessionBridge({ controller, agents }: SessionBridgeDeps): SessionBridge;
//#endregion