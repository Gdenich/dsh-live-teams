import { TeamMessage } from "./mailbox.js";
import { TaskStore } from "./task-store.js";
//#region src/assignment-guard.d.ts
export declare function assignmentFence(message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>): {
  taskId: string;
  attemptId: string;
  assignee: string;
} | undefined;
/** Inspect durable ownership, not prose or an Agent's generic running flag. */
export declare function assignmentDeliveryAllowed(store: Pick<TaskStore, 'listTasks' | 'readAttempts'>, message: Pick<TeamMessage, 'from' | 'to' | 'threadId'>, sessionId?: string, bindingGeneration?: number): Promise<boolean>;
//#endregion