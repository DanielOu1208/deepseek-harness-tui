import type { Agent } from '@deepseek-ai/dsh-agent';
import type { DeepSeekTui } from './ui.js';
export interface QueueControllerDependencies {
    ui: DeepSeekTui;
    getAgent(): Agent;
    isClosing(): boolean;
}
export declare class QueueController {
    private readonly deps;
    constructor(deps: QueueControllerDependencies);
    private find;
    choose(): Promise<void>;
}
