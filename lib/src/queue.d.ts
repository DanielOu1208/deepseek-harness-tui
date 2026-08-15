import type { UserMessage } from '@deepseek-ai/dsh-llm';
export type QueuePlacement = 'next-step' | 'next-turn';
export interface QueueItemView {
    id: string;
    placement: QueuePlacement;
    text: string;
    editable: boolean;
    imageCount: number;
}
export declare function queueItemView(message: UserMessage, placement: QueuePlacement): QueueItemView;
export declare function queueItems(nextStep: readonly UserMessage[], nextTurn: readonly UserMessage[]): QueueItemView[];
export declare function queueItemLabel(item: QueueItemView, maxChars?: number): string;
