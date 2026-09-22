import React from 'react';
import type { MessageKind, TaskStatus, TeamAttemptStatus, TeamSubmissionScope } from './api.js';
import type { LocaleKey } from './locales.js';
import './styles.js';
export type TeamViewContext = {
    readonly sessions: {
        open(sessionId: string): void;
    };
    readonly t: (key: LocaleKey) => string;
};
export type TeamViewProps = {
    readonly ctx?: TeamViewContext;
    /** Session the view belongs to; the host serves this Session's workspace team. */
    readonly sessionId?: string;
    /** How often the tab re-reads tasks while visible. Exposed so the test can watch it. */
    readonly pollMs?: number;
};
export type TaskFilter = 'active' | 'waiting' | 'archived';
export declare const attemptStatusKeys: Record<TeamAttemptStatus, LocaleKey>;
export declare const scopeKeys: Record<TeamSubmissionScope['state'], LocaleKey>;
export declare const scopeReasonKeys: Record<NonNullable<TeamSubmissionScope['reason']>, LocaleKey>;
export declare const taskStatusKeys: Record<TaskStatus, LocaleKey>;
export declare const taskFilterKeys: Record<TaskFilter, LocaleKey>;
export declare const messageKindKeys: Record<MessageKind, LocaleKey>;
export declare function TeamView(props: TeamViewProps): React.ReactElement;
export default TeamView;
