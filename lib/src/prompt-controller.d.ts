import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
import { readClipboardImage } from './clipboard-image.js';
import type { SessionDraftStoreLike } from './drafts.js';
import type { DeepSeekTui } from './ui.js';
export interface PromptControllerDependencies {
    ctx: Context;
    ui: DeepSeekTui;
    draftStore: SessionDraftStoreLike;
    startupCwd?: string;
    getAgent(): Agent | undefined;
    getSelection(): ModelSelectionRef | undefined;
    isClosing(): boolean;
    readClipboardImage?: typeof readClipboardImage;
}
export interface PromptControllerApi {
    installInteractions(): void;
    disposeInteractions(): void;
    scheduleDraftSave(text: string): void;
    persistCurrentDraft(text?: string): Promise<void>;
    restoreCurrentDraft(): Promise<void>;
    flushDrafts(): Promise<void>;
    hasPendingImages(): boolean;
    clearPendingImages(): void;
    pasteClipboardImage(): Promise<void>;
    chooseAttachments(path?: string): Promise<void>;
    beginPrompt(text: string): Promise<string>;
    promptMessage(text: string): Promise<UserMessage>;
    completePrompt(sessionId: string): Promise<void>;
    recoverPrompt(sessionId: string, submittedText: string): Promise<void>;
    confirmDiscardPendingImages(): Promise<boolean>;
}
export declare class PromptController implements PromptControllerApi {
    private readonly deps;
    private draftSaveTimer?;
    private pendingImages;
    private readonly interactionDisposers;
    constructor(deps: PromptControllerDependencies);
    installInteractions(): void;
    disposeInteractions(): void;
    private askApproval;
    private askQuestions;
    private cancelDraftSave;
    scheduleDraftSave(text: string): void;
    persistCurrentDraft(text?: string): Promise<void>;
    restoreCurrentDraft(): Promise<void>;
    flushDrafts(): Promise<void>;
    hasPendingImages(): boolean;
    clearPendingImages(): void;
    private addPendingImage;
    private attachImagePath;
    pasteClipboardImage(): Promise<void>;
    chooseAttachments(path?: string): Promise<void>;
    beginPrompt(text: string): Promise<string>;
    completePrompt(sessionId: string): Promise<void>;
    recoverPrompt(sessionId: string, submittedText: string): Promise<void>;
    promptMessage(text: string): Promise<UserMessage>;
    confirmDiscardPendingImages(): Promise<boolean>;
}
