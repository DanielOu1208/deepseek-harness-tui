import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DeepSeekTui } from './ui.js';
interface CurrentSession {
    agent: Agent;
    generation: number;
}
export interface SessionInsightsDependencies {
    ctx: Context;
    ui: DeepSeekTui;
    startupCwd?: string;
    getCurrentSession: () => CurrentSession;
}
export declare class SessionInsightsController {
    private readonly dependencies;
    private activityLoadAbort?;
    constructor(dependencies: SessionInsightsDependencies);
    private get ctx();
    private get ui();
    private presentedToolMutations;
    chooseDeliverable(): Promise<void>;
    private visibilitySnapshot;
    private inspectorToolDetail;
    chooseInspectorEntry(): Promise<void>;
    showSessionStats(): void;
    showActivity(): Promise<void>;
    exportSession(argument: string): Promise<void>;
    interrupt(): void;
    shutdown(): void;
}
export {};
