import type { SessionEvent, TodoItem } from '@deepseek-ai/dsh-session';
import type { TokenUsage } from '@deepseek-ai/dsh-llm';
export type TranscriptRole = 'user' | 'assistant' | 'tool' | 'system';
export type TranscriptKind = 'text' | 'reasoning' | 'tool';
export type ContextForm = 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall' | 'opaque';
export type SystemEntryKind = 'routine' | 'todo' | 'goal' | 'approval' | 'retry' | 'important';
export interface FileDiff {
    path: string;
    oldText: string | null;
    newText: string;
}
export interface ContextPresentation {
    form: ContextForm;
    sourceKind: string;
    label: string;
    summary: string;
}
export interface ToolPresentation {
    card: 'terminal' | 'generic' | 'diff' | 'read' | 'search' | 'web' | 'unknown';
    summary?: string;
}
export interface TranscriptEntry {
    id: string;
    role: TranscriptRole;
    kind: TranscriptKind;
    text: string;
    streaming: boolean;
    detail?: string;
    diffs?: FileDiff[];
    toolName?: string;
    toolArguments?: unknown;
    context?: ContextPresentation;
    toolPresentation?: ToolPresentation;
    systemKind?: SystemEntryKind;
    systemSummary?: string;
    error?: boolean;
}
export interface ProjectionState {
    sessionId: string;
    entries: TranscriptEntry[];
    running: boolean;
    activeTools: Array<{
        id: string;
        name: string;
    }>;
    usage?: TokenUsage;
    todos: TodoItem[];
    compacting: boolean;
    planMode: boolean;
    permissionPreset?: string;
    goal?: {
        objective: string;
        phase: string;
        roundsStarted: number;
    };
    retry?: {
        provider: string;
        retry: number;
        maxRetries?: number;
        delayMs: number;
    };
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    requestContext?: {
        provider: string;
        model: string;
        contextWindow?: number;
    };
    contextUsageReady?: boolean;
    contextWindow?: {
        usedTokens?: number;
        capacityTokens: number;
    };
    lastError?: string;
}
export interface EventLike {
    seq: number;
    time: number;
    type: string;
    data: unknown;
    surfaceOp?: 'append' | {
        op: 'replace';
        start: number;
        end: number;
    };
}
export interface ToolPresenter {
    presentCall(name: string, argumentsValue: unknown): unknown;
    presentResult(name: string, argumentsValue: unknown, result: {
        content: unknown[];
        isError: boolean;
        meta?: unknown;
    }): unknown;
}
export declare function createProjection(sessionId: string): ProjectionState;
export declare function foldSessionEvent(state: ProjectionState, event: EventLike, presenter?: ToolPresenter): ProjectionState;
export declare function projectSession(sessionId: string, events: readonly SessionEvent[], presenter?: ToolPresenter): ProjectionState;
