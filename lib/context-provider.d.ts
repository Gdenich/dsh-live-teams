import { MemberRecord, TeamState } from "./team-store.js";
import { TeamTask } from "./task-store.js";
import { LiveTeamsRole } from "./roles.js";
//#region src/context-provider.d.ts
export declare const MEMBERSHIP_CONTEXT_NAME = "live-teams:membership";
export declare const MEMBERSHIP_CONTEXT_ORDER = 125;
export declare function sessionIdOf(assemblyContext: unknown): string | undefined;
export type MembershipMember = Pick<MemberRecord, 'memberId' | 'displayName' | 'role' | 'availability' | 'bindingGeneration' | 'contractRevision' | 'note'> & {
  sessionId?: string;
  roles?: readonly string[];
  [key: string]: unknown;
};
export type RoleRegistrySync = {
  resolve: (value: string) => Pick<LiveTeamsRole, 'body'> | undefined;
};
export type MembershipScope = {
  teamId: string;
  /** Set when a human wrote into this member's Session mid-attempt (B31). */
  humanIntervenedAt?: number;
  teamName?: string;
  activeAttemptId?: string;
  activeTask?: TeamTask;
  tasks?: readonly TeamTask[];
  formalToolsAvailable?: boolean;
  roleRegistry?: RoleRegistrySync;
  teamState?: TeamState;
  workspacePath?: string;
  live?: (member: MemberRecord) => boolean;
  /**
   * Comments addressed to this member that it has not acknowledged. A comment is stored with
   * `wakePolicy: never`, so nothing wakes the Session for it — without this line the recipient never
   * learns it was written (external review, finding 13).
   */
  comments?: readonly {
    from: string;
    content: string;
    at: number;
  }[];
};
export declare function renderMembership(member: MembershipMember, scope: MembershipScope): string;
type SyncStore = {
  memberBySessionSync: (teamId: string, sessionId: string) => MembershipMember | undefined;
  teamStateSync?: (teamId: string) => TeamState | undefined;
  attemptSync?: (teamId: string, taskId: string) => {
    humanIntervenedAt?: number;
    humanIntervenedContractRevision?: number;
    generation: number;
  } | undefined;
  activeTaskForMemberSync?: (teamId: string, memberId: string) => TeamTask | undefined;
  tasksSync?: (teamId: string) => readonly TeamTask[] | undefined;
};
export type MembershipContextBinding = {
  readonly store: SyncStore;
  readonly teamId: string;
  readonly teamName?: string | (() => string);
  readonly workspacePath?: string;
  readonly enabled?: () => boolean;
  readonly roleRegistry?: RoleRegistrySync;
  readonly live?: (member: MemberRecord) => boolean;
  readonly activeTaskForMemberSync?: (teamId: string, memberId: string) => TeamTask | undefined;
  readonly tasksSync?: (teamId: string) => readonly TeamTask[] | undefined;
  readonly attemptSync?: (teamId: string, taskId: string) => {
    humanIntervenedAt?: number;
    humanIntervenedContractRevision?: number;
    generation: number;
  } | undefined;
  /** Unread comments for a member, read synchronously because the context is assembled that way. */
  readonly commentsSync?: (teamId: string, memberId: string) => readonly {
    from: string;
    content: string;
    at: number;
  }[];
};
export type MembershipContextOptions = {
  readonly store?: SyncStore;
  readonly teamId?: string;
  readonly teamName?: string | (() => string);
  readonly workspacePath?: string;
  readonly onError?: (error: unknown) => void;
  readonly formalToolsAvailable?: boolean;
  readonly roleRegistry?: RoleRegistrySync;
  readonly resolveSession?: (sessionId: string) => MembershipContextBinding | undefined;
  readonly enabled?: () => boolean;
  readonly live?: (member: MemberRecord) => boolean;
  readonly activeTaskForMemberSync?: (teamId: string, memberId: string) => TeamTask | undefined;
  readonly tasksSync?: (teamId: string) => readonly TeamTask[] | undefined;
  readonly attemptSync?: (teamId: string, taskId: string) => {
    humanIntervenedAt?: number;
    humanIntervenedContractRevision?: number;
    generation: number;
  } | undefined;
  readonly commentsSync?: (teamId: string, memberId: string) => readonly {
    from: string;
    content: string;
    at: number;
  }[];
};
export type MembershipContextProvider = {
  name: string;
  order: number;
  teamId: string;
  text: (assemblyContext: unknown) => string;
  definition: () => {
    name: string;
    order: number;
    text: (assemblyContext: unknown) => string;
  };
};
export declare function createMembershipContextProvider(options: MembershipContextOptions): MembershipContextProvider;
//#endregion