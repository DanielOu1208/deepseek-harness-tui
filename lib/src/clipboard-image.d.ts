import type { ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
export interface ClipboardCommand {
    file: string;
    args: string[];
    outputFile?: string;
}
export type ClipboardCommandRunner = (command: ClipboardCommand, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
export declare function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined;
export declare function readClipboardImage(options?: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
    runner?: ClipboardCommandRunner;
}): Promise<SaveImageAttachment | undefined>;
