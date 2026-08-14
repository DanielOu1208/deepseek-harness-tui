import { parseCmdline } from '@deepseek-ai/dsh-cmdline';
import { Command } from 'commander';
export const name = 'dsh-tui-startup';
export const inject = ['cmdlineArgs'];
export const DSH_TUI_STARTUP_SERVICE = 'dshTuiStartup';
export function createTuiCommand(onParsed) {
    const program = new Command()
        .name('dsh --profile tui')
        .description('Run the official DeepSeek Harness through an interactive terminal UI.')
        .helpOption('-h, --help', 'show this help')
        .option('-r, --resume <session-id>', 'resume a persisted session')
        .option('-C, --cwd <directory>', 'working directory for a new session')
        .option('-p, --prompt <words...>', 'submit an initial prompt after startup')
        .argument('[initial-prompt...]', 'optional initial prompt without --prompt')
        .addHelpText('after', `
Examples:
  dsh --profile tui
  dsh --profile tui --resume session-abc
  dsh --profile tui "fix the failing tests"
`);
    program.action(() => {
        const raw = program.opts();
        const positional = program.args.join(' ').trim();
        const optionPrompt = raw.prompt?.join(' ').trim();
        onParsed({
            ...(raw.resume === undefined ? {} : { resume: raw.resume }),
            ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
            ...(optionPrompt ? { prompt: optionPrompt } : positional ? { prompt: positional } : {}),
        });
    });
    return program;
}
export function apply(ctx) {
    const program = createTuiCommand(options => {
        ctx.provide(DSH_TUI_STARTUP_SERVICE, options);
    });
    parseCmdline(ctx, program);
}
