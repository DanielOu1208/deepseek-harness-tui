import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { Command } from 'commander'

export const name = 'dsh-tui-startup'
export const inject = ['cmdlineArgs']
export const DSH_TUI_STARTUP_SERVICE = 'dshTuiStartup'

export interface TuiStartupOptions {
  resume?: string
  cwd?: string
  prompt?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshTuiStartup: TuiStartupOptions
  }
}

export function createTuiCommand(onParsed: (options: TuiStartupOptions) => void): Command {
  const program = new Command()
    .name('deepseek')
    .description('Run the official DeepSeek Harness through an interactive terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session-id>', 'resume a persisted session')
    .option('-C, --cwd <directory>', 'working directory for a new session')
    .option('-p, --prompt <words...>', 'submit an initial prompt after startup')
    .argument('[initial-prompt...]', 'optional initial prompt without --prompt')
    .addHelpText('after', `
Examples:
  deepseek
  deepseek --resume session-abc
  deepseek "fix the failing tests"
`)

  program.action(() => {
    const raw = program.opts<{ resume?: string; cwd?: string; prompt?: string[] }>()
    const positional = program.args.join(' ').trim()
    const optionPrompt = raw.prompt?.join(' ').trim()
    onParsed({
      ...(raw.resume === undefined ? {} : { resume: raw.resume }),
      ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
      ...(optionPrompt ? { prompt: optionPrompt } : positional ? { prompt: positional } : {}),
    })
  })
  return program
}

export function apply(ctx: Context): void {
  const program = createTuiCommand(options => {
    ctx.provide(DSH_TUI_STARTUP_SERVICE, options)
  })
  parseCmdline(ctx, program)
}
