import { Editor, TuiAltScreen, type Component, type AutocompleteProvider, type SelectItem, type SlashCommand, type Terminal } from '@earendil-works/pi-tui';
import type { ProjectionState, TranscriptEntry } from './projection.js';
/**
 * Remove terminal control strings supplied by models, tools, files, or plugins.
 * Newlines and tabs remain available to Markdown; raw CSI/OSC/DCS/APC/PM/SOS
 * sequences and other C0/C1 controls never reach the terminal renderer.
 *
 * This is a single-pass parser rather than a backtracking regex so hostile,
 * unterminated control strings cannot make rendering super-linear.
 */
export declare function sanitizeTerminalText(text: string): string;
export declare function isSettingsShortcut(data: string): boolean;
export type CtrlCAction = 'interrupt' | 'exit';
export declare class CtrlCExitGate {
    private readonly windowMs;
    private previousPress;
    constructor(windowMs?: number);
    press(now?: number): CtrlCAction;
    reset(): void;
}
export declare function createCommandAutocomplete(commands: readonly SlashCommand[], cwd: string): AutocompleteProvider;
export declare function renderLaunchBanner(sessionId: string, cwd: string): string;
export declare function formatEntry(entry: TranscriptEntry): string;
export declare class ControlBar implements Component {
    invalidate(): void;
    render(width: number): string[];
}
export declare class StatusLine implements Component {
    private state?;
    private note;
    update(state: ProjectionState, note?: string): void;
    setNote(note: string): void;
    invalidate(): void;
    render(width: number): string[];
}
export interface TuiCallbacks {
    onPrompt(text: string): void | Promise<void>;
    onSettings(): void | Promise<void>;
    onInterrupt(): void | Promise<void>;
    onExit(): void | Promise<void>;
}
export declare class DeepSeekTui {
    readonly tui: TuiAltScreen;
    readonly editor: Editor;
    private readonly transcript;
    private readonly scroll;
    private readonly status;
    private readonly components;
    private entryIds;
    private notices;
    private projection?;
    private callbacks?;
    private pendingText?;
    private overlayActive;
    private readonly ctrlCExit;
    private started;
    constructor(terminal?: Terminal);
    setSlashCommands(commands: readonly SlashCommand[], cwd: string): void;
    start(callbacks: TuiCallbacks): void;
    stop(): void;
    renderProjection(state: ProjectionState): void;
    appendNotice(text: string): void;
    appendLaunchBanner(sessionId: string, cwd: string): void;
    setStatus(note: string): void;
    flashError(error: unknown): void;
    choose(title: string, items: SelectItem[], signal?: AbortSignal): Promise<SelectItem | undefined>;
    promptText(title: string, signal?: AbortSignal): Promise<string | undefined>;
    private markdown;
}
