import type { ToolCallView } from '@deepseek-ai/dsh-tools';
export interface PresentedToolMutation {
    seq: number;
    turn: number;
    failed: boolean;
    callView?: ToolCallView;
}
export interface Deliverable {
    path: string;
    firstSeq: number;
    turn: number;
}
export declare function deriveDeliverables(records: readonly PresentedToolMutation[]): Deliverable[];
export declare function deliverableBasename(path: string): string;
