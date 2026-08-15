import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type PickerItem } from './interaction.js';
import type { DeepSeekTui } from './ui.js';
export interface SessionNavigatorDependencies {
    ctx: Context;
    ui: DeepSeekTui;
    getAgent(): Agent;
    requestSwitch(id: string): Promise<void>;
}
export declare class SessionNavigator {
    private readonly deps;
    private readonly cache;
    private loadAbort?;
    constructor(deps: SessionNavigatorDependencies);
    interrupt(reason?: Error): void;
    invalidate(id: string): void;
    hasCached(id: string): boolean;
    private archivedIds;
    chooseSession(archived?: boolean): Promise<void>;
    chooseWorkspace(): Promise<void>;
    private beginLoad;
    private finishLoad;
    private loadForPicker;
    loadPickerItems(signal?: AbortSignal, archivedOnly?: boolean): Promise<PickerItem[]>;
    private loadSource;
    private liveSource;
    private source;
}
