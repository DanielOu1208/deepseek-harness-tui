import type { SlashCommand } from '@earendil-works/pi-tui';
export type LocalCommandName = 'help' | 'new' | 'resume' | 'sessions' | 'pause' | 'stop' | 'model' | 'models' | 'reasoning' | 'permission' | 'busy' | 'settings' | 'queue' | 'steer' | 'exit';
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
export declare const HELP_TEXT = "Local TUI commands:\n  /new                       start a fresh session\n  /sessions                  list persisted sessions\n  /resume <session-id>       open a persisted session\n  /models                    list available models\n  /model <provider>/<model>  switch the next model request\n  /reasoning <effort>        select model reasoning effort\n  /permission <mode>         read-only | workspace-write | danger-full-access\n  /busy <queue|steer>        choose plain Enter behavior while busy\n  /settings                  open core TUI settings\n  /stop                      stop the active turn\n  /pause                     stop, flush, print the resume id, and exit\n  /steer <text>              steer the nearest agent step\n  /queue <text>              queue a separate follow-up turn\n  /exit                      flush and exit\n\nOfficial Harness commands such as /compact, /goal, and /feedback are passed to ctx.commands.";
