export interface WorkflowMemberActivity {
    seq: number;
    label: string;
    phase?: string;
    childId: string;
    outcome: 'running' | 'completed' | 'failed' | 'cancelled';
}
export interface WorkflowRunActivity {
    id: string;
    name: string;
    startedAt: number;
    endedAt?: number;
    stopReason?: string;
    members: readonly WorkflowMemberActivity[];
}
export interface WorkflowEventLike {
    readonly type: string;
    readonly time: number;
    readonly data: unknown;
}
/** Fold the durable tool-workflow records in a parent session. */
export declare function projectWorkflowActivity(events: readonly WorkflowEventLike[]): WorkflowRunActivity[];
