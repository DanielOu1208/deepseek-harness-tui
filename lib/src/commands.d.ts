import type { SlashCommand } from '@earendil-works/pi-tui';
declare const LOCAL_COMMAND_DEFINITIONS: readonly [{
    readonly name: "exit";
    readonly description: "Flush the session and exit";
}, {
    readonly name: "help";
    readonly description: "Show TUI and official Harness commands";
}, {
    readonly name: "model";
    readonly description: "Switch the model for the next request";
    readonly argumentHint: "<provider>/<model>";
}, {
    readonly name: "models";
    readonly description: "List available models";
}, {
    readonly name: "reasoning";
    readonly description: "Select reasoning effort for the current model";
    readonly argumentHint: "[default|effort]";
}, {
    readonly name: "new";
    readonly description: "Start a fresh session";
}, {
    readonly name: "session";
    readonly description: "Rename, fork, or archive a session";
    readonly argumentHint: "[session-id]";
}, {
    readonly name: "workspaces";
    readonly description: "Browse sessions grouped by workspace";
}, {
    readonly name: "pause";
    readonly description: "Stop, persist, and exit with a resume ID";
}, {
    readonly name: "permission";
    readonly description: "Set the tool permission mode";
    readonly argumentHint: "<mode>";
}, {
    readonly name: "busy";
    readonly description: "Choose what plain Enter does while the agent is busy";
    readonly argumentHint: "[queue|steer]";
}, {
    readonly name: "settings";
    readonly description: "Open the core TUI settings menu";
}, {
    readonly name: "queue";
    readonly description: "Manage queued work or add a follow-up";
    readonly argumentHint: "[prompt]";
}, {
    readonly name: "resume";
    readonly description: "Search sessions or open one by ID";
    readonly argumentHint: "[session-id]";
}, {
    readonly name: "sessions";
    readonly description: "Search and switch sessions";
}, {
    readonly name: "steer";
    readonly description: "Steer the nearest active agent step";
    readonly argumentHint: "<prompt>";
}, {
    readonly name: "attach";
    readonly description: "Attach an image to the next prompt";
    readonly argumentHint: "[path]";
}, {
    readonly name: "deliverables";
    readonly description: "Browse files produced by successful tools";
}, {
    readonly name: "inspect";
    readonly description: "Inspect steps and tool calls";
}, {
    readonly name: "stats";
    readonly description: "Show timing and token statistics";
}, {
    readonly name: "activity";
    readonly description: "Show jobs, workflows, and subagents";
}, {
    readonly name: "export";
    readonly description: "Export the current session";
    readonly argumentHint: "[markdown|json]";
}, {
    readonly name: "stop";
    readonly description: "Stop the active turn";
}];
export type LocalCommandName = (typeof LOCAL_COMMAND_DEFINITIONS)[number]['name'];
export type ParsedInput = {
    kind: 'prompt';
    text: string;
} | {
    kind: 'harness-command';
    line: string;
} | {
    kind: 'local';
    name: LocalCommandName;
    argument: string;
};
export interface HarnessCommandDescriptor {
    readonly name: string;
    readonly description: string;
    readonly input?: {
        readonly hint: string;
    };
}
export declare const LOCAL_SLASH_COMMANDS: readonly SlashCommand[];
export declare function buildSlashCommands(harness: readonly HarnessCommandDescriptor[]): SlashCommand[];
export declare function formatCommandHelp(commands: readonly SlashCommand[]): string;
export declare function parseInput(input: string): ParsedInput;
export {};
