import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { CodeDispatchEventData, CodeDispatchStartEventData } from '@deepseek-ai/dsh-tools/types';
/** The four disjoint provider usage buckets used by the official token meter. */
export interface VisibilityTokenTotals {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
/** Whole-log timing figures with the same semantics as rc.6 session-stats. */
export interface VisibilityTimingTotals {
    turns: number;
    steps: number;
    llmMs: number;
    toolMs: number;
    ttftMs: number;
    ttftSteps: number;
    decodeMs: number;
    decodeTokens: number;
    /** Nested Code Mode dispatch time, kept separate from official toolMs. */
    subtoolMs: number;
}
export type VisibilityStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'aborted' | 'blocked' | 'interrupted' | 'max-tokens' | 'orphaned' | 'unknown';
export type VisibilityTrajectoryKind = 'turn' | 'step' | 'user' | 'assistant' | 'tool' | 'subtool';
/** A compact, renderer-neutral event/object row for a trajectory inspector. */
export interface VisibilityTrajectoryRecord {
    id: string;
    kind: VisibilityTrajectoryKind;
    seq: number;
    time: number;
    turn?: number;
    step?: number;
    endSeq?: number;
    endedAt?: number;
    durationMs?: number;
    status?: VisibilityStatus;
    callId?: string;
    parentCallId?: string;
    rootCallId?: string;
    name?: string;
    summary?: string;
}
/** One model step and its independently inspectable timing facts. */
export interface VisibilityStepRecord {
    id: string;
    turn: number;
    step: number;
    startSeq: number;
    startedAt: number;
    endSeq?: number;
    completedAt?: number;
    firstTokenAt?: number;
    modelMs?: number;
    ttftMs?: number;
    decodeMs?: number;
    outputTokens?: number;
    usage?: VisibilityTokenTotals;
    status: VisibilityStatus;
}
/** One root tool call or nested Code Mode dispatch paired by its call id. */
export interface VisibilityToolRecord {
    id: string;
    kind: 'tool' | 'subtool';
    callId: string;
    turn?: number;
    step?: number;
    name: string;
    startSeq: number;
    startedAt: number;
    resultSeq?: number;
    finishedAt?: number;
    durationMs?: number;
    status: VisibilityStatus;
    parentCallId?: string;
    rootCallId?: string;
    argumentsText?: string;
    resultText?: string;
    resultMetaText?: string;
    resultIsError?: boolean;
}
export interface VisibilitySnapshot {
    sessionId?: string;
    lastSeq: number;
    trajectory: readonly VisibilityTrajectoryRecord[];
    steps: readonly VisibilityStepRecord[];
    tools: readonly VisibilityToolRecord[];
    timing: VisibilityTimingTotals;
    tokens: VisibilityTokenTotals;
}
/** Per-record and collection limits. All limits are enforced by the fold. */
export interface VisibilityLimits {
    maxTrajectoryRecords: number;
    maxStepRecords: number;
    maxToolRecords: number;
    maxTextChars: number;
}
export declare const DEFAULT_VISIBILITY_LIMITS: Readonly<VisibilityLimits>;
/** Mutable, O(1)-per-event accumulator. Call {@link snapshotVisibility} for a safe view. */
export interface VisibilityProjection {
    readonly sessionId?: string;
    readonly limits: Readonly<VisibilityLimits>;
    lastSeq: number;
    append(event: VisibilityEvent): VisibilityProjection;
    snapshot(): VisibilitySnapshot;
}
interface VisibilityEventEnvelope<Type extends string, Data> {
    type: Type;
    seq: number;
    time: number;
    data: Data;
    ignorable?: true;
}
/** rc.6 session events, including the public Code Mode event extension. */
export type VisibilityEvent = SessionEvent | VisibilityEventEnvelope<'tool/code-dispatch-start', CodeDispatchStartEventData> | VisibilityEventEnvelope<'tool/code-dispatch', CodeDispatchEventData>;
/** Create an incremental visibility fold for one session. */
export declare function createVisibilityProjection(sessionId?: string, limits?: Partial<VisibilityLimits>): VisibilityProjection;
/** Append one event in sequence order; duplicate/older sequence numbers are ignored. */
export declare function foldVisibilityEvent(projection: VisibilityProjection, event: VisibilityEvent): VisibilityProjection;
/** Replay an event iterable and return an immutable-by-convention snapshot. */
export declare function projectVisibility(events: Iterable<VisibilityEvent>, sessionId?: string, limits?: Partial<VisibilityLimits>): VisibilitySnapshot;
/** Copy the bounded public view without exposing mutable fold internals. */
export declare function snapshotVisibility(projection: VisibilityProjection): VisibilitySnapshot;
export {};
